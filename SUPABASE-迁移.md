# Supabase 持久化设置（手把手）

把日程数据从「本地 JSON 文件」改成「Supabase 云端数据库」，这样 **Render 怎么重启、休眠、重新部署，数据都不会丢**。

全程约 10 分钟，免费，不需要写代码。

---

## 第 1 步：创建 Supabase 项目

1. 打开 [supabase.com](https://supabase.com)，点右上角 **「Start your project」/「Sign in」**，用 **GitHub 账号登录**（和你部署 Render 用的是同一个，最省事）。
2. 登录后进入 Dashboard，点 **「New project」**（绿色按钮）。
3. 填写：
   - **Name**：`couple-calendar`（随便起）
   - **Database Password**：点 「Generate a password」自动生成一个，**先复制保存好**（后面一般用不到，但别丢）
   - **Region**：选离你们近的，如 **Southeast Asia (Singapore)**
4. 点 **「Create new project」**，等 **1~2 分钟**初始化完成。

## 第 2 步：建 3 张数据表（跑一段 SQL）

1. 进入项目后，看左侧菜单栏，点 **「SQL Editor」**（数据库图标）。
2. 点 **「New query」**（或右上角 +）。
3. 把下面**整段 SQL** 复制粘贴进去，点右下角 **「Run」**（或 Ctrl+Enter）：

```sql
-- 情侣日历 · 建表脚本
create table if not exists spaces (
  id text primary key,
  name text not null default '我们的空间',
  invite_code text not null unique,
  together_since text,
  created_at timestamptz not null default now()
);

create table if not exists members (
  id text primary key,
  space_id text not null references spaces(id) on delete cascade,
  nickname text not null,
  timezone text not null default 'Asia/Shanghai',
  color text not null default '#6ea8fe',
  token text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists events (
  id text primary key,
  space_id text not null references spaces(id) on delete cascade,
  author_id text not null,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  notes text not null default '',
  type text not null default 'event',
  done boolean not null default false,
  repeat text not null default 'none',
  reminder_minutes integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_members_token on members(token);
create index if not exists idx_members_space on members(space_id);
create index if not exists idx_events_space on events(space_id);
create index if not exists idx_spaces_invite on spaces(invite_code);

-- 开启行级安全：外部匿名访问被拒绝；服务端用 service_role 密钥不受影响
alter table spaces enable row level security;
alter table members enable row level security;
alter table events enable row level security;
```

4. 运行成功后，下面会显示 **「Success. No rows returned」**，左侧能看到多出 `spaces`、`members`、`events` 三张表，就成功了 ✅

## 第 3 步：拿到两个密钥

1. 左侧菜单点 **「Project Settings」**（齿轮图标）→ **「API」**（有的版本在 Data / API 里）。
2. 记下这两个值（**只给自己用，不要分享、不要传到公开的 GitHub**）：
   - **Project URL**：形如 `https://xxxxxxx.supabase.co`
   - **service_role key**：在 **「Project API keys」** 区域，找 **`service_role`** 那一行的 key（很长一串，点眼睛图标显示后复制）

> ⚠️ 要复制的是 **service_role**（带 secret 的那个），不是 anon/public 那个。

## 第 4 步（可选）：本地先测一下

在 `couple-calendar` 文件夹里：

1. 把 `.env.example` 复制一份，改名为 `.env`；
2. 用记事本打开 `.env`，填上你刚才拿到的两个值：

```
SUPABASE_URL=https://你的项目ID.supabase.co
SUPABASE_SERVICE_ROLE_KEY=你的service_role密钥
```

3. 保存，然后运行 `npm start`，浏览器打开 http://localhost:3000，正常使用即可（数据已存到 Supabase）。

## 第 5 步：在 Render 上配置（正式上线）

在 Render 的 Web Service 设置页，找到 **「Environment」→「Environment Variables」**，点 **「Add Environment Variable」**，加两条：

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://你的项目ID.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | 你的 service_role 密钥 |

加完后 Render 会自动重新部署，等 1~2 分钟即可。现在不管 Render 怎么重启，数据都在 Supabase 里，**不会再丢**。

---

## 常见问题

- **打开页面能看日历，但一操作就报「缺少环境变量」**：说明 Render 的环境变量没配好，或本地没建 `.env`。检查第 4 / 5 步的 Key 是否**完全一致**（注意大小写、下划线）。
- **报 `relation "spaces" does not exist`**：第 2 步的 SQL 没跑成功，回 SQL Editor 重新 Run 一次。
- **报 `new row violates row-level security policy`**：一般不会出现（服务端用 service_role 绕过 RLS）。若出现，说明你误用了 anon key，请确认复制的是 **service_role**。
- **想清空所有数据重来**：SQL Editor 里运行 `truncate table events, members, spaces;`
