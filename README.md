# Doubao Node Studio

面向豆包 AI 视频生产的本地无限画布：在一个工程中整理图片、文本和视频节点，连接参考图与提示词，提交到已登录的豆包网页，并将任务状态和无水印成片回传到视频节点。

## 包含

- 无限画布：图片、文本、视频节点和连接关系；工程画布保存在本机服务端，而非浏览器缓存。
- `@` 素材引用：画布提示词在提交时转换为豆包所需的“图1、图2……”描述。
- Seedance 2.0 Fast 工作流：4–10 秒时长、比例、任务状态、失败/审核结果与成片版本。
- 浏览器桥接扩展：操作用户已登录的豆包网页；浏览器 Cookie 仅留在本机账号 Profile。
- 无水印媒体下载：在豆包页面能够解析到原始媒体地址时保存本地成片。

## 本地启动

前提：Windows、Google Chrome、Node.js 20+。克隆或下载本仓库后，双击 `启动工作台.cmd`，再打开 <http://127.0.0.1:4318>。

首次使用时，在专用 Chrome for Testing 账号窗口中登录豆包，并在 `chrome://extensions` 加载 `bridge-extension` 文件夹。工作台与扩展通过本机 `127.0.0.1` 通信。

## 本地数据与隐私

首次运行会自动创建：

- `data/`：工程 JSON、上传素材副本、账号浏览器 Profile、任务记录、下载成片；
- `用户素材库/`：跨工程素材库；
- `runtime/`：本机下载的 Chrome for Testing 运行时。

这些目录均被 `.gitignore` 排除，仓库与 Releases 不包含个人参考图、项目工程、生成视频、账号登录 Cookie 或浏览器 Profile。请在发布前再次确认 `git status --ignored`。

## 配套 Skill

导演工作流与 10 秒镜头设计请使用 [AI Video Director Skill](https://github.com/robinxyz627/ai-video-director-skill)。工作台是可选工具，不改变豆包模型本身的使用额度或平台规则。

## License

MIT
