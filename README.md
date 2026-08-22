# AI Travel Planner

本地优先的 AI 智能旅行规划助手。运行 `npm install`、`npm run dev`，首次在本机创建用户名和至少 8 位密码后使用。旅行数据写入 `private_data/`，该目录不会被便携包复制。默认服务端口为 `6688`（浏览器安全端口）。

生产运行：`npm run build` 后执行 `npm run start`。Windows 可执行 `npm run package:windows`；macOS 使用 `bash scripts/build_portable_macos.sh <Node.js-24-目录>`。
