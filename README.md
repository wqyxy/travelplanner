# AI Travel Planner

本地优先的 AI 智能旅行规划助手。运行 `npm install`、`npm run dev`，首次在本机创建用户名和至少 6 位密码后使用。旅行数据写入 `private_data/`，该目录不会被便携包复制。默认服务端口为 `6688`（浏览器安全端口）。

登录后可从侧边栏的“修改密码”更新访问密码。密码规则仅为 JavaScript 字符串长度不少于 6；修改密码不会中断当前浏览器/设备登录或已连接的实时更新。

生产运行：`npm run build` 后执行 `npm run start`。Windows 可执行 `npm run package:windows`；macOS 使用 `bash scripts/build_portable_macos.sh <Node.js-24-目录>`。
