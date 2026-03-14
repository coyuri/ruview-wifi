/**
 * skeleton3d.js — RuView 3D Skeleton Viewer
 *
 * フェーズ1: WireframeDriver（body-model.js）でワイヤーフレーム骨格表示
 * フェーズ2（あとで）: VrmDriver に差し替えて .vrm アバターを動かす
 *
 * データパイプライン:
 *   PoseSystem (simulation) ──┐
 *                              ├→ KeypointAdapter → WireframeDriver → Three.js
 *   WebSocket (ESP32 live)  ──┘
 */

import { BodyModel } from './components/body-model.js';
import { Scene }     from './components/scene.js';
import { PoseSystem } from './observatory/js/pose-system.js';

// ═══════════════════════════════════════════════════════════════════
// KeypointAdapter
// PoseSystem 出力 [[x,y,z]×17] を BodyModel.targetPositions に変換
// VRM対応時は toVrmRotations() を実装するだけ
// ═══════════════════════════════════════════════════════════════════

class KeypointAdapter {
  /** midpoint of two [x,y,z] triplets */
  _mid(a, b) {
    return [
      (a[0] + b[0]) * 0.5,
      (a[1] + b[1]) * 0.5,
      (a[2] + b[2]) * 0.5,
    ];
  }

  /**
   * PoseSystem の [[x,y,z]×17] を BodyModel.targetPositions に直接書き込む。
   * updateFromKeypoints() を使わないことで正規化座標変換を回避し、
   * 3D ワールド座標をそのまま使う。
   *
   * @param {BodyModel} model
   * @param {Array}     kps17   [[x,y,z], ...]  COCO 17 keypoints
   * @param {number}    conf    0-1 confidence
   * @param {number[]}  offset  [dx, dy, dz] person position offset
   */
  applyToWireframe(model, kps17, conf, offset = [0, 0, 0]) {
    model.confidence = conf;
    model.isVisible = conf > 0.05;
    model.group.visible = model.isVisible;
    if (!model.isVisible || !kps17 || kps17.length < 17) return;

    const dx = offset[0], dy = offset[1], dz = offset[2];
    const p = (i) => [kps17[i][0] + dx, kps17[i][1] + dy, kps17[i][2] + dz];
    const set = (name, xyz) => {
      if (model.targetPositions[name]) {
        model.targetPositions[name] = { x: xyz[0], y: xyz[1], z: xyz[2] };
      }
    };

    // ── 直接マッピング ──
    set('left_shoulder',  p(5));
    set('right_shoulder', p(6));
    set('left_elbow',     p(7));
    set('right_elbow',    p(8));
    set('left_wrist',     p(9));
    set('right_wrist',    p(10));
    set('left_hip',       p(11));
    set('right_hip',      p(12));
    set('left_knee',      p(13));
    set('right_knee',     p(14));
    set('left_ankle',     p(15));
    set('right_ankle',    p(16));

    // ── 計算で導出 ──
    const nose  = p(0);
    const chest = this._mid(p(5), p(6));          // 両肩の中点
    const pelvis = this._mid(p(11), p(12));        // 両ヒップの中点
    const spine  = this._mid(chest, pelvis);       // 胸とヒップの中点

    // 頭: 鼻位置から +10cm 上
    const head = [nose[0], nose[1] + 0.10, nose[2]];
    // 首: 鼻と胸の中間
    const neck  = this._mid(nose, chest);

    set('head',   head);
    set('neck',   neck);
    set('chest',  chest);
    set('spine',  spine);
    set('pelvis', pelvis);
  }

  /**
   * フェーズ2 (VRM) 用スタブ。
   * kps17 から VRM ヒューマノイドボーン回転クォータニオンを計算する。
   * 実装時は:
   *   - 各ボーン親→子の方向ベクトルを計算
   *   - THREE.Quaternion.setFromUnitVectors() で回転を算出
   *   - vrm.humanoid.getBoneNode(VRMHumanBoneName.LeftUpperArm).rotation 等に適用
   *
   * @param {Array} kps17  [[x,y,z], ...]
   * @returns {null}  (フェーズ2で VrmBoneRotations オブジェクトを返す)
   */
  toVrmRotations(kps17) {
    return null; // TODO フェーズ2
  }
}

// ═══════════════════════════════════════════════════════════════════
// WireframeDriver — フェーズ1 実装
// フェーズ2では VrmDriver に置き換えるだけ
// ═══════════════════════════════════════════════════════════════════

class WireframeDriver {
  constructor(threeScene, adapter) {
    this._adapter = adapter;
    this._models = new Map();  // personId → BodyModel
    this._scene = threeScene;
  }

  /**
   * @param {Array}    personsKps  [{id, kps17, conf, offset}]
   * @param {number}   delta
   */
  update(personsKps, delta) {
    const seen = new Set();

    for (const { id, kps17, conf, offset } of personsKps) {
      seen.add(id);
      if (!this._models.has(id)) {
        const m = new BodyModel();
        this._scene.add(m.group);
        this._models.set(id, m);
      }
      const model = this._models.get(id);
      this._adapter.applyToWireframe(model, kps17, conf, offset || [0, 0, 0]);
    }

    // 不要なモデルを削除（一定時間データが来なかった person）
    for (const [id, model] of this._models) {
      if (!seen.has(id)) {
        model.confidence -= delta * 0.5; // フェードアウト
        if (model.confidence <= 0) {
          this._scene.remove(model.group);
          this._models.delete(id);
        }
      }
      model.update(delta);
    }
  }

  dispose() {
    for (const model of this._models.values()) {
      this._scene.remove(model.group);
    }
    this._models.clear();
  }
}

/*
 * ═══════════════════════════════════════════════════════════════════
 * VrmDriver — フェーズ2 スタブ（あとで実装）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 使い方（フェーズ2）:
 *   1. skeleton3d.html に以下を追加:
 *      <script src="https://unpkg.com/three@0.160.0/examples/js/loaders/GLTFLoader.js"></script>
 *      <script src="https://unpkg.com/@pixiv/three-vrm@2/lib/three-vrm.js"></script>
 *
 *   2. skeleton3d.js の app.init() を:
 *      this.driver = new WireframeDriver(...)
 *      → await VrmDriver.create(scene, './avatar.vrm', adapter)
 *      に差し替えるだけ。
 *
 * class VrmDriver {
 *   static async create(threeScene, url, adapter) {
 *     const driver = new VrmDriver(threeScene, adapter);
 *     await driver._load(url);
 *     return driver;
 *   }
 *   async _load(url) {
 *     const loader = new THREE.GLTFLoader();
 *     loader.register(p => new THREE.VRMLoaderPlugin(p));
 *     const gltf = await loader.loadAsync(url);
 *     this._vrm = gltf.userData.vrm;
 *     this._vrm.scene.rotation.y = Math.PI; // VRM は Z-forward
 *     this._scene.add(this._vrm.scene);
 *   }
 *   update(personsKps, delta) {
 *     this._vrm.update(delta);
 *     if (!personsKps.length) return;
 *     const rots = this._adapter.toVrmRotations(personsKps[0].kps17);
 *     if (!rots) return;
 *     const hum = this._vrm.humanoid;
 *     hum.getBoneNode('hips').rotation.copy(rots.hips);
 *     hum.getBoneNode('spine').rotation.copy(rots.spine);
 *     // ... 全ボーン適用
 *   }
 * }
 */

// ═══════════════════════════════════════════════════════════════════
// SimulationEngine
// ═══════════════════════════════════════════════════════════════════

class SimulationEngine {
  constructor() {
    this._ps      = new PoseSystem();
    this._elapsed = 0;
    this.pose     = 'auto';   // 'auto' | 'standing' | 'walking' | 'sitting' | 'crouching'
    this._poses   = ['standing', 'walking', 'sitting', 'crouching'];
    this._cycleT  = 8; // 秒ごとに自動切り替え
  }

  update(delta) {
    this._elapsed += delta;
  }

  /**
   * @param {number} idx  person index (0-based)
   * @param {number[]} offset [x,0,z] position
   * @returns {Array} [[x,y,z]×17]
   */
  getKeypoints(idx, offset = [0, 0, 0]) {
    const t  = this._elapsed;
    const bp = Math.sin(t * 1.05 * Math.PI * 2 / 60 * 16) * 0.012; // 16 breaths/min

    let pose = this.pose;
    if (pose === 'auto') {
      const poseIdx = Math.floor(t / this._cycleT) % this._poses.length;
      pose = this._poses[poseIdx];
    }

    // 複数人を少し離して配置
    const px = offset[0] + (idx === 0 ? -0.6 : 0.6);
    const pz = offset[2];

    const person = {
      pose,
      position: [px, 0, pz],
      motion_score: pose === 'walking' ? 60 : 20,
      facing: idx === 1 ? Math.PI : 0,
    };

    return this._ps.generateKeypoints(person, t + idx * 1.3, bp);
  }

  currentPoseName() {
    if (this.pose !== 'auto') return this.pose;
    const idx = Math.floor(this._elapsed / this._cycleT) % this._poses.length;
    return this._poses[idx];
  }
}

// ═══════════════════════════════════════════════════════════════════
// WebSocketClient — 軽量版（再接続5回まで）
// ═══════════════════════════════════════════════════════════════════

class WsClient {
  constructor(onData, onState) {
    this._onData  = onData;
    this._onState = onState;
    this._ws      = null;
    this._retries = 0;
    this._maxRetries = 5;
    this._connect();
  }

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url   = `${proto}://${location.host}/ws/sensing`;

    try {
      this._ws = new WebSocket(url);
    } catch {
      this._scheduleRetry();
      return;
    }

    // 3秒以内に OPEN しなければ SIMULATION へ
    const openTimeout = setTimeout(() => {
      if (this._ws && this._ws.readyState !== WebSocket.OPEN) {
        this._ws.close();
        this._onState('simulation');
      }
    }, 3000);

    this._ws.onopen = () => {
      clearTimeout(openTimeout);
      this._retries = 0;
      this._onState('connected');
    };

    this._ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        this._onData(data);
      } catch { /* ignore parse errors */ }
    };

    this._ws.onclose = () => {
      clearTimeout(openTimeout);
      this._scheduleRetry();
    };

    this._ws.onerror = () => {
      clearTimeout(openTimeout);
    };
  }

  _scheduleRetry() {
    if (this._retries >= this._maxRetries) {
      this._onState('simulation');
      return;
    }
    this._retries++;
    const delay = Math.min(2000 * this._retries, 10000);
    setTimeout(() => this._connect(), delay);
  }
}

// ═══════════════════════════════════════════════════════════════════
// ESP32 NodeMarkers — 四隅に八面体 + PointLight
// ═══════════════════════════════════════════════════════════════════

function buildNodeMarkers(threeScene) {
  const positions = [
    [-3.2, 2.4, -2.5],
    [ 3.2, 2.4, -2.5],
    [-3.2, 2.4,  2.5],
    [ 3.2, 2.4,  2.5],
  ];
  const markers = positions.map((pos, i) => {
    const geo  = new THREE.OctahedronGeometry(0.10, 0);
    const mat  = new THREE.MeshPhongMaterial({
      color: 0x00ccff, emissive: 0x004466,
      transparent: true, opacity: 0.75
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...pos);
    threeScene.add(mesh);

    const light = new THREE.PointLight(0x00ccff, 0.25, 3.5);
    light.position.set(...pos);
    threeScene.add(light);

    // Node ID ラベル（スプライト）
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,200,255,0.8)';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`N${i}`, 32, 24);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    sprite.position.set(pos[0], pos[1] + 0.3, pos[2]);
    sprite.scale.set(0.4, 0.2, 1);
    threeScene.add(sprite);

    return { mesh, light, active: false };
  });
  return markers;
}

function buildFloor(threeScene) {
  const grid = new THREE.GridHelper(10, 20, 0x112233, 0x0a1525);
  grid.position.y = 0;
  threeScene.add(grid);

  // 受信エリアを示す薄い円
  const ringGeo = new THREE.RingGeometry(1.8, 2.0, 48);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x00ccff, transparent: true, opacity: 0.08, side: THREE.DoubleSide
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  threeScene.add(ring);
}

// ═══════════════════════════════════════════════════════════════════
// Skeleton3DApp
// ═══════════════════════════════════════════════════════════════════

class Skeleton3DApp {
  constructor() {
    this._paused       = false;
    this._liveMode     = false;
    this._serverPersons = [];
    this._nodeActive   = new Set();
    this._lastUpdate   = 0;
  }

  init() {
    this._loadingProgress(20, 'Creating 3D scene...');

    // ── Scene ──
    const container = document.getElementById('canvas-container');
    this._scene3d = new Scene(container);

    this._loadingProgress(40, 'Building skeleton...');

    // ── SkeletonDriver（フェーズ1: Wireframe）──
    this._adapter = new KeypointAdapter();
    this._driver  = new WireframeDriver(this._scene3d.scene, this._adapter);

    // ── Simulation ──
    this._sim = new SimulationEngine();

    // ── Environment ──
    buildFloor(this._scene3d.scene);
    this._nodeMarkers = buildNodeMarkers(this._scene3d.scene);

    this._loadingProgress(60, 'Connecting to sensor...');

    // ── WebSocket ──
    this._ws = new WsClient(
      (data) => this._handleData(data),
      (state) => this._handleWsState(state)
    );

    // ── Animation loop ──
    this._scene3d.onUpdate((delta, elapsed) => this._tick(delta, elapsed));
    this._scene3d.start();

    this._loadingProgress(80, 'Binding controls...');

    // ── UI ──
    this._bindControls();

    // loading 完了
    setTimeout(() => {
      this._loadingProgress(100, 'Ready');
      setTimeout(() => {
        const el = document.getElementById('loading');
        el.classList.add('hidden');
        setTimeout(() => { el.style.display = 'none'; }, 700);
      }, 300);
    }, 400);
  }

  // ── animation tick ──────────────────────────────────────────────

  _tick(delta, elapsed) {
    if (this._paused) return;

    this._sim.update(delta);

    let personsKps;

    if (this._liveMode && this._serverPersons.length > 0) {
      // ライブモード: サーバーから来た persons を使用
      personsKps = this._serverPersons.map((p, i) => ({
        id:     p.id ?? i,
        kps17:  this._serverPersonToKps17(p),
        conf:   p.confidence ?? 0.7,
        offset: [0, 0, 0],
      })).filter(p => p.kps17 !== null);

      // 3秒以上データが来ない → シミュレーションへ
      if (performance.now() - this._lastUpdate > 3000) {
        this._liveMode = false;
        this._updateBadge('sim');
      }
    } else {
      // シミュレーションモード: PoseSystem で1人分生成
      personsKps = [{
        id:     'sim-0',
        kps17:  this._sim.getKeypoints(0, [0, 0, 0]),
        conf:   0.85,
        offset: [0, 0, 0],
      }];
    }

    this._driver.update(personsKps, delta);
    this._pulseNodes(elapsed);
  }

  // ── server data → kps17 変換 ────────────────────────────────────

  _serverPersonToKps17(person) {
    // サーバーの persons[].keypoints は [{name, x, y, z, confidence}, ...]
    const COCO_NAMES = [
      'nose','left_eye','right_eye','left_ear','right_ear',
      'left_shoulder','right_shoulder','left_elbow','right_elbow',
      'left_wrist','right_wrist','left_hip','right_hip',
      'left_knee','right_knee','left_ankle','right_ankle',
    ];

    if (!person.keypoints || person.keypoints.length < 17) {
      // pose_keypoints: [[x,y,z,conf]×17] フォーマットも試みる
      if (person.pose_keypoints && person.pose_keypoints.length >= 17) {
        return person.pose_keypoints.map(kp => [kp[0], kp[1], kp[2] ?? 0]);
      }
      return null;
    }

    // name ベースの keypoints をCOCO順に並べ替え
    const byName = {};
    for (const kp of person.keypoints) { byName[kp.name] = kp; }
    return COCO_NAMES.map((name, i) => {
      const kp = byName[name];
      return kp ? [kp.x, kp.y, kp.z ?? 0] : [0, i < 5 ? 1.6 : 0.9, 0];
    });
  }

  // ── WebSocket データ処理 ─────────────────────────────────────────

  _handleData(data) {
    if (data.msg_type !== 'sensing_update') return;

    // ノードのアクティブ状態を更新
    if (data.nodes) {
      this._nodeActive = new Set(data.nodes.map(n => n.node_id));
      document.getElementById('node-active').textContent = this._nodeActive.size;
    }

    // persons があればライブモードへ
    if (data.persons && data.persons.length > 0) {
      this._serverPersons = data.persons;
      this._liveMode      = true;
      this._lastUpdate    = performance.now();
      this._updateBadge('live');
    } else if (data.source === 'esp32') {
      // ESP32からのデータだがポーズなし → サーバー接続バッジ
      this._updateBadge('srv');
    }

    // バイタルサイン更新
    if (data.vital_signs) {
      const vs = data.vital_signs;
      document.getElementById('stat-hr').textContent =
        vs.heart_rate ? Math.round(vs.heart_rate) + ' bpm' : '--';
      document.getElementById('stat-resp').textContent =
        vs.breathing_rate ? vs.breathing_rate.toFixed(1) + '/m' : '--';
    }

    // 推定人数・信頼度
    if (data.estimated_persons !== undefined) {
      document.getElementById('stat-persons').textContent = data.estimated_persons;
    }
    if (data.classification?.confidence !== undefined) {
      document.getElementById('stat-conf').textContent =
        Math.round(data.classification.confidence * 100) + '%';
    }
  }

  _handleWsState(state) {
    if (state === 'simulation') {
      this._liveMode = false;
      this._updateBadge('sim');
    } else if (state === 'connected') {
      this._updateBadge('srv');
    }
  }

  _updateBadge(type) {
    const el = document.getElementById('source-badge');
    el.className = 'badge';
    if (type === 'live') {
      el.className += ' badge--live';
      el.textContent = 'LIVE / ESP32';
    } else if (type === 'srv') {
      el.className += ' badge--srv';
      el.textContent = 'SERVER (no pose)';
    } else {
      el.className += ' badge--sim';
      el.textContent = 'SIMULATION';
    }
  }

  // ── ノードマーカー点滅 ──────────────────────────────────────────

  _pulseNodes(elapsed) {
    this._nodeMarkers.forEach((m, i) => {
      const active = this._nodeActive.has(i);
      const pulse  = active
        ? 0.5 + Math.sin(elapsed * 3.5 + i * 0.8) * 0.35
        : 0.15;
      m.mesh.material.opacity  = pulse * 0.8;
      m.light.intensity        = active ? pulse * 0.35 : 0.04;
      m.mesh.rotation.y       += 0.008;
      m.mesh.rotation.x       += 0.004;
    });
  }

  // ── UI ──────────────────────────────────────────────────────────

  _bindControls() {
    const btnPause = document.getElementById('btn-pause');
    btnPause.addEventListener('click', () => {
      this._paused = !this._paused;
      btnPause.textContent = this._paused ? '▶ Resume' : '⏸ Pause';
      btnPause.classList.toggle('active', this._paused);
    });

    document.getElementById('pose-select').addEventListener('change', (e) => {
      this._sim.pose = e.target.value;
    });

    document.getElementById('btn-reset-cam').addEventListener('click', () => {
      this._scene3d.camera.position.set(8, 7, 10);
      this._scene3d.camera.lookAt(0, 1.5, 0);
      this._scene3d.controls.target.set(0, 1.2, 0);
      this._scene3d.controls.update();
    });
  }

  // ── ローディング ─────────────────────────────────────────────────

  _loadingProgress(pct, msg) {
    const bar = document.getElementById('loading-bar');
    const txt = document.getElementById('loading-msg');
    if (bar) bar.style.width = pct + '%';
    if (txt) txt.textContent = msg;
  }
}

// ── エントリーポイント ──────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  new Skeleton3DApp().init();
});
