# 课程表（nuo 独立环境版）

这是从工坊版「课程表」转换而来的独立微应用，目标运行时为教程中的 `window.nuo.*` / `Nuojiji.*` 环境，不使用 `window.AiPhone`。

## 已保留

- 周视图、日视图
- 手动添加、编辑、删除课程
- 当前课程与下一节课提示
- 文本 / TXT / CSV / HTML 课表导入
- AI 从文本解析课表
- 截图选择、压缩与视觉识别
- 本地持久化存档
- 自定义 CSS
- 多周方案保存与切换
- 同步到 nuo 原生日历（需要目标环境提供 `nuo.calendar.add` 或 `nuo.calendar.create`）

## 已移除

- 多周与多方案存档
- 原生日历同步
- 分享给角色
- 外部 CDN 与 DOCX 解析依赖

DOCX 可直接选择导入；应用会在本地读取 DOCX 内的 `word/document.xml`，不需要外部脚本。若目标浏览器不支持 `DecompressionStream`，再将 DOCX 另存为 TXT、CSV 或 HTML。应用不包含外部网络资源，也不内置 API key。

## 文件

- `manifest.json`：权限与应用元数据
- `index.html`：完整单文件应用
- `icon.svg`：应用图标

## 安装

将目录打包为 ZIP 后导入目标环境。若目标环境只接受 PNG 图标，可将 `icon.svg` 转换为 PNG，并同步修改 manifest 的 `icon` 字段。
