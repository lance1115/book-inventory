# 固定域名部署

这个项目是纯静态 PWA，可以直接部署到 GitHub Pages、Cloudflare Pages、Netlify 或 Vercel。

推荐 GitHub Pages：

1. 新建一个公开 GitHub 仓库，例如 `book-inventory`.
2. 上传本目录下所有文件。
3. 在仓库 `Settings -> Pages` 中选择 `Deploy from a branch`。
4. Branch 选择 `main`，目录选择 `/root`。
5. 发布后使用 `https://你的用户名.github.io/book-inventory/` 打开。

如果要绑定自有域名，在 Pages 的 `Custom domain` 中填写域名，并按 GitHub 提示添加 DNS 记录。
