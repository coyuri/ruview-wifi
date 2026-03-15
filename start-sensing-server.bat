@echo off
cd /d "c:\Users\coyuri\.antigravity\RuView\RuView\rust-port\wifi-densepose-rs\crates\wifi-densepose-sensing-server"
echo Starting WiFi-DensePose Sensing Server...
echo HTTP:  http://localhost:8082
echo WS:    ws://localhost:8082/ws/sensing
echo UI:    http://localhost:8082/ui/skeleton3d.html
echo.
"c:\Users\coyuri\.antigravity\RuView\RuView\rust-port\wifi-densepose-rs\target\debug\sensing-server.exe" ^
  --bind-addr 0.0.0.0 ^
  --source esp32 ^
  --http-port 8082 ^
  --ws-port 8083 ^
  --ui-path "c:\Users\coyuri\.antigravity\RuView\RuView\ui"
pause
