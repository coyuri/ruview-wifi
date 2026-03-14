//! SONA online learning pipeline: connects LoRA + EWC++ real-time adaptation
//! to the live ESP32 CSI pipeline.
//!
//! Receives CSI feature samples from `udp_receiver_task` via an mpsc channel,
//! batches them, and runs `SonaAdapter::adapt` on each batch.  EWC++ Fisher
//! information is updated after every adaptation and consolidated periodically
//! to prevent catastrophic forgetting.

use tokio::sync::mpsc;

use crate::sona::{SonaAdapter, SonaConfig, AdaptationSample, EwcRegularizer, EnvironmentDetector};

// ── Public types ────────────────────────────────────────────────────────────

/// A single CSI sample pushed from the UDP receiver task.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SonaSample {
    pub csi_features: Vec<f32>,
    pub pseudo_label: f32,
    pub confidence: f64,
    pub tick: u64,
}

/// Live telemetry state for the SONA pipeline (readable via REST).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SonaLiveState {
    pub enabled: bool,
    pub adaptation_count: u64,
    pub last_adaptation_tick: u64,
    pub last_loss: f32,
    pub last_ewc_penalty: f32,
    pub drift_detected: bool,
    pub drift_magnitude: f32,
    pub samples_buffered: usize,
    pub samples_dropped: u64,
    pub lora_delta_norm: f32,
}

impl Default for SonaLiveState {
    fn default() -> Self {
        Self {
            enabled: false,
            adaptation_count: 0,
            last_adaptation_tick: 0,
            last_loss: 0.0,
            last_ewc_penalty: 0.0,
            drift_detected: false,
            drift_magnitude: 0.0,
            samples_buffered: 0,
            samples_dropped: 0,
            lora_delta_norm: 0.0,
        }
    }
}

/// Pipeline-level configuration, separate from SonaConfig (which controls
/// LoRA hyper-parameters).
#[derive(Debug, Clone)]
pub struct SonaPipelineConfig {
    /// Minimum frames between adaptation runs.
    pub adaptation_interval_frames: u64,
    /// Minimum samples required to trigger an adaptation run.
    pub min_batch_size: usize,
    /// Samples below this confidence are discarded.
    pub confidence_threshold: f64,
    /// Number of model parameters SONA adapts (must match LoRA in_features).
    pub param_count: usize,
    /// LoRA rank used when constructing the SonaAdapter.
    pub lora_rank: usize,
    /// Run EWC++ consolidation every N adaptations.
    pub ewc_consolidate_every: u64,
    /// Window size for environment drift detection.
    pub drift_window: usize,
}

impl Default for SonaPipelineConfig {
    fn default() -> Self {
        Self {
            adaptation_interval_frames: 300,
            min_batch_size: 32,
            confidence_threshold: 0.75,
            param_count: 15,
            lora_rank: 4,
            ewc_consolidate_every: 10,
            drift_window: 50,
        }
    }
}

// ── SharedState alias (mirrors main.rs) ─────────────────────────────────────

/// The state type used by the pipeline task — matches `SharedState` in main.rs.
/// We use a trait-object-free approach: accept a concrete Arc<RwLock<S>> where
/// S has the `sona_state` field.  Instead of importing AppStateInner (which
/// would create a circular dependency), we pass the SharedState directly.

// ── Adaptation task ─────────────────────────────────────────────────────────

/// Long-running Tokio task that consumes `SonaSample` values from `rx`,
/// batches them, and runs SONA adaptation.  After each adaptation it writes
/// a brief telemetry snapshot back into `AppStateInner::sona_state` via the
/// provided `SharedState`.
///
/// The task borrows `Arc<RwLock<crate::AppStateInner>>` but because
/// `AppStateInner` is defined in `main.rs` (a binary crate), we cannot name
/// it here.  We therefore pass the update through a `tokio::sync::watch`
/// channel instead, and main.rs installs a second task that forwards watch
/// values into `s.sona_state`.
pub async fn sona_adaptation_task(
    state_tx: tokio::sync::watch::Sender<SonaLiveState>,
    mut rx: mpsc::Receiver<SonaSample>,
    config: SonaPipelineConfig,
) {
    let sona_config = SonaConfig {
        lora_rank: config.lora_rank,
        ..SonaConfig::default()
    };

    let mut adapter = SonaAdapter::new(sona_config, config.param_count);
    let mut env_detector = EnvironmentDetector::new(config.drift_window);

    // Base parameter vector (zero-initialised; SONA learns deltas via LoRA).
    let mut base_params = vec![0.0f32; config.param_count];

    let mut sample_buffer: Vec<AdaptationSample> = Vec::with_capacity(256);
    let mut frames_since_adapt: u64 = 0;
    let mut adapt_count: u64 = 0;
    let mut last_tick: u64 = 0;
    let mut last_loss: f32 = 0.0;
    let mut last_ewc_penalty: f32 = 0.0;
    let mut lora_delta_norm: f32 = 0.0;

    tracing::info!("SONA pipeline task started (param_count={}, lora_rank={})",
        config.param_count, config.lora_rank);

    while let Some(sample) = rx.recv().await {
        // Drop low-confidence samples.
        if sample.confidence < config.confidence_threshold {
            continue;
        }

        last_tick = sample.tick;

        // Update environment drift detector with mean and variance of the
        // incoming CSI feature vector.
        let feat = &sample.csi_features;
        let n = feat.len() as f32;
        if n > 0.0 {
            let mean = feat.iter().sum::<f32>() / n;
            let var = feat.iter().map(|&x| (x - mean) * (x - mean)).sum::<f32>() / n;
            env_detector.update(mean, var);
        }

        // Build an AdaptationSample (target is the pseudo-label scalar).
        let adaptation_sample = AdaptationSample {
            csi_features: sample.csi_features.clone(),
            target: vec![sample.pseudo_label],
        };

        // Maintain a ring buffer of at most 256 samples.
        if sample_buffer.len() >= 256 {
            sample_buffer.remove(0);
        }
        sample_buffer.push(adaptation_sample);
        frames_since_adapt += 1;

        // Check whether it is time to adapt.
        let should_adapt = frames_since_adapt >= config.adaptation_interval_frames
            && sample_buffer.len() >= config.min_batch_size;

        if !should_adapt {
            // Publish buffered count without running adaptation.
            let drift_info = env_detector.drift_info();
            let live = SonaLiveState {
                enabled: true,
                adaptation_count: adapt_count,
                last_adaptation_tick: last_tick,
                last_loss,
                last_ewc_penalty,
                drift_detected: env_detector.drift_detected(),
                drift_magnitude: drift_info.magnitude,
                samples_buffered: sample_buffer.len(),
                samples_dropped: 0, // tracked in AppStateInner
                lora_delta_norm,
            };
            let _ = state_tx.send(live);
            continue;
        }

        // --- Run adaptation ---
        frames_since_adapt = 0;
        adapt_count += 1;

        let result = adapter.adapt(&base_params, &sample_buffer);
        last_loss = result.final_loss;
        last_ewc_penalty = result.ewc_penalty;

        // Compute LoRA delta norm: sqrt( sum( (adapted - base)^2 ) )
        lora_delta_norm = result.adapted_params.iter()
            .zip(base_params.iter())
            .map(|(&a, &b)| (a - b) * (a - b))
            .sum::<f32>()
            .sqrt();

        // Update EWC Fisher using numerical differentiation on a simple MSE
        // closure over the current buffer.
        {
            let buf_snap: Vec<AdaptationSample> = sample_buffer.clone();
            let adapted_snap = result.adapted_params.clone();
            let new_fisher = EwcRegularizer::compute_fisher(
                &adapted_snap,
                move |p: &[f32]| {
                    let n = buf_snap.len() as f32;
                    if n == 0.0 { return 0.0; }
                    buf_snap.iter().map(|s| {
                        let pred = p.iter().zip(s.csi_features.iter())
                            .map(|(&w, &x)| w * x)
                            .sum::<f32>();
                        let e = pred - s.target[0];
                        e * e
                    }).sum::<f32>() / n
                },
                1, // one pass is sufficient for diagonal Fisher
            );
            adapter.ewc.update_fisher(&new_fisher);
        }

        // Periodic EWC consolidation.
        if adapt_count % config.ewc_consolidate_every == 0 {
            adapter.ewc.consolidate(&result.adapted_params);
            tracing::debug!("SONA EWC++ consolidated at adaptation #{}", adapt_count);
        }

        // Advance base params to the newly adapted params.
        base_params = result.adapted_params;

        tracing::info!(
            "SONA adapt #{}: loss={:.4}, ewc_penalty={:.4}, delta_norm={:.4}, steps={}",
            adapt_count, last_loss, last_ewc_penalty, lora_delta_norm, result.steps_taken
        );

        // Broadcast updated telemetry.
        let drift_info = env_detector.drift_info();
        let live = SonaLiveState {
            enabled: true,
            adaptation_count: adapt_count,
            last_adaptation_tick: last_tick,
            last_loss,
            last_ewc_penalty,
            drift_detected: env_detector.drift_detected(),
            drift_magnitude: drift_info.magnitude,
            samples_buffered: sample_buffer.len(),
            samples_dropped: 0,
            lora_delta_norm,
        };
        let _ = state_tx.send(live);
    }

    tracing::info!("SONA pipeline task exiting (channel closed)");
}
