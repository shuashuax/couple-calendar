# 部署到 Render（手把手，零命令行）

本教程面向「不太会用 Git/GitHub，但会登录 GitHub 浏览项目」的新手。全程不需要敲任何命令行。

---

## ⚠️ 第 0 步：先配好 Supabase（重要，约 10 分钟）

本项目的数据已经改成存到 **Supabase 云端数据库**，所以 **Render 免费版重启、休眠、重新部署都不会再丢数据**。

但前提是你得先建好 Supabase 项目、建表、拿到密钥。请先照 [`SUPABASE-迁移.md`](./SUPABASE-迁移.md) 完成前三步，拿到下面两个值，后面第 2 步部署时会用到：

- `SUPABASE_URL`（形如 `https://xxxx.supabase.co`）
- `SUPABASE_SERVICE_ROLE_KEY`（service_role 那一串，**保密**，别传到公开 GitHub）

---

## 第 1 步：把代码放到 GitHub

### 方式 A：GitHub 网页上传（推荐，最简单）

1. 用浏览器登录 [github.com](https://github.com)，点右上角头像旁的 **「+」**，选 **「New repository」**。
2. 填写：
   - **Repository name**：`couple-calendar`（只能英文/数字/横线）
   - 选 **Public**（公开。代码里没有任何密钥/密码，选公开最简单也免费）
   - 下面「Add a README file / Add .gitignore / Choose a license」**都不要勾**，保持空白
3. 点绿色的 **「Create repository」**。
4. 进入新建好的空仓库页面，找到并点击链接 **「uploading an existing file」**（中文界面可能是「上传一个已有文件」；在页面上方「Quick setup」区域里）。
   - 如果找不到这个链接，就点仓库页面上方的 **「Add file」** 下拉按钮 → 选 **「Upload files」**，效果一样。
5. 在电脑上打开这个文件夹：
   `C:\Users\xiaojun\Documents\deepseek-harness\default-workspace\couple-calendar`
6. **只选中下面这 7 样**（按住 Ctrl 逐个点选，或框选），一起拖进网页的上传框：

   | 要上传 ✅ | 不要上传 ❌ |
   |---|---|
   | `server.js` | `node_modules`（几千个文件，又大又没用） |
   | `package.json` | `.npm-cache`（缓存） |
   | `package-lock.json` | `data`（你的日程数据，隐私） |
   | `README.md` | |
   | `.gitignore` | |
   | `lib` 文件夹 | |
   | `public` 文件夹 | |

   > 拖文件夹时，GitHub 会保留 `lib/`、`public/` 的目录结构，放心拖。
7. 等文件全部传完（绿色对勾），拉到页面最下面，在 **「Commit changes」** 框里写一句说明（比如 `first commit`），点绿色的 **「Commit changes」** 按钮。
8. 完成后回到仓库主页，确认能看到 `server.js`、`package.json`、`lib`、`public` 等文件，就成功了 ✅。

### 方式 B：命令行（可选，适合以后想更新代码的人）

如果你愿意学一点 git（我可以帮你执行本地部分，你只需要在浏览器里点一次登录授权）：

```bash
cd "C:\Users\xiaojun\Documents\deepseek-harness\default-workspace\couple-calendar"
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/你的用户名/couple-calendar.git
git push -u origin main
```

第一次 `git push` 时，Windows 会弹出浏览器让你登录 GitHub 并授权，点允许即可。

---

## 第 2 步：在 Render 上部署

1. 打开 [render.com](https://render.com)，点 **「Get Started」/「Sign up」**，选择 **用 GitHub 账号登录**（最省事，直接关联你的仓库）。
2. 登录后进入 Dashboard，点右上角 **「New +」** 按钮 → 选 **「Web Service」**。
3. 第一次会弹出 GitHub 授权页，点 **「Authorize Render」**（授权它读取你的仓库）。然后在下拉列表里选 **`couple-calendar`**。
   - 如果列表里没有，点 **「Configure GitHub access」**，在跳出的页面里选中该仓库，再回来刷新。
4. 进入配置页，这样填：
   - **Name**：`couple-calendar`（随便起）
   - **Region**：选离你们近的（如 **Singapore**）
   - **Branch**：`main`（默认）
   - **Runtime**：`Node`（一般会自动识别，因为有 `package.json`）
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：选 **Free**（免费）
   - **Environment Variables**：点 **「Add Environment Variable」**，添加两条（值来自第 0 步）：
     - Key `SUPABASE_URL`，Value 填你的 Project URL
     - Key `SUPABASE_SERVICE_ROLE_KEY`，Value 填你的 service_role 密钥
5. 拉到页面最下面，点 **「Create Web Service」**（或「Deploy Web Service」）。
6. 等 **2~4 分钟**，页面出现 **「Your service is live 🎉」**，顶部绿色链接就是你的网址，形如：
   `https://couple-calendar-xxxx.onrender.com`
7. 用**手机**和**电脑**浏览器分别打开这个网址，即可像本地一样使用。

---

## 第 3 步：以后更新代码

- **网页上传法**：进仓库 → **「Add file」→「Upload files」** → 重新上传改过的文件 → 提交，Render 会自动重新部署。
- **命令行法**：`git add . && git commit -m "更新" && git push`，Render 自动部署。

---

## 常见问题

- **首次打开很慢/转圈**：免费版 15 分钟无访问会休眠，下次打开要等约 1 分钟「冷启动」，属正常，不是坏了。
- **两人能实时同步吗**：能。Render 支持 WebSocket，且前端在连接断开时会自动重连。
- **数据会不会丢**：不会，数据存在 Supabase 云端。若报「缺少环境变量」，检查第 0 步的两个环境变量是否配好。
- **想删掉重新部署**：Dashboard 里点服务 → Settings → 底部「Delete Service」。
