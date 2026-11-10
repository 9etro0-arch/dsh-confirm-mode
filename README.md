# dsh-confirm-mode

DSH 确认模式插件。在输入框工具栏、权限下拉框（Read Only / Workspace Write / Full
Access）旁边加一个「确认模式」开关。开启后，**每次调用敏感权限都会要求你逐条确认**，
而不是自动审批。

该模式**独立于创造模式**，也独立于 DSH 自带的权限预设：它不改变你当前的权限档位，
只在「敏感权限被调用」这一刻强制要求用户确认。

## 行为

- **默认（关闭）**：与 DSH 原有行为完全一致，本插件不干预。
- **确认模式（开启）**：
  - 工具调用请求提升 `sandbox_permissions`（例如请求 `danger-full-access`、
    `workspace-write`）时，**这一次调用必须先经你确认**才执行；
  - 沙箱提权（让文件操作或命令离开工作区的一次性放行）始终交给你点确认，
    绝不自动批准，也绝不代你拒绝；
  - `allowed-once` 是唯一的授权，且只对**这一次调用**有效 —— 下一次敏感调用
    会再问你一遍，这就是「每次都要求用户确认」。

### 什么是「敏感权限」

| 场景 | 判定 |
|---|---|
| 工具调用带 `sandbox_permissions` 参数（请求更宽的沙箱） | 敏感，逐条确认 |
| 请求的权限**严于**当前会话有效模式（例如 Workspace Write 下请求 Full Access） | 该调用自身会发起提权审批，本插件**不重复弹窗**，只保证那次审批一定到达你 |
| 请求的权限**已被**当前会话覆盖（Full Access 下） | 本来完全不会有任何提示 —— 正是这种静默情况由本插件接管确认 |
| `sensitiveTools` 配置里点名的工具（默认为空） | 每次调用都逐条确认 |
| 其余普通调用 | 不干预 |

### 与 Full Access 的关系

DSH 在 Full Access 下不会发起任何审批请求，所以「确认模式」是在该档位下唯一能让
敏感调用停下来问你一声的机制。开启本模式时，会话的审批策略会被保持为 `ask`
（`never` 会在任何回答者之前就把请求直接判为拒绝，与「要求确认」相反），因此即使你
正处在 Full Access，确认提示也能正常弹出。

## 配置

两个值，两个入口：

| 入口 | 位置 | 作用范围 |
|---|---|---|
| 输入框工具栏开关 | 权限下拉框旁边 | **当前会话**：只改这个会话 |
| 默认确认模式 | 设置 → 插件 → dsh-confirm-mode | **默认值**：没有自己开关过模式的会话跟随它 |

工具栏开关不会改写默认值；默认值只对没有自己设过模式的会话生效。

存储位置：**默认模式**是本插件的配置项（由宿主写在 profile patch 里）；
**按会话的模式**写在 `$DSH_HOME/confirm-mode/sessions.json`（插件自有目录，原子写入）。
两者都立即生效并持久保存。

### 可调项（Settings → Plugins，或 profile patch）

```yaml
- id: dsh-confirm-mode
  name: dsh-confirm-mode
  config:
    defaultMode: off          # off | on —— 新会话的默认确认模式
    sensitiveTools: []        # 每次调用都视为敏感的工具名列表（小写），如 [pwsh, bash, edit, write]
```

## 安装

需要 dsh CLI（`>=0.1.1-rc.2`，实测 `0.2.1-rc.5`）。

从本地目录安装（开发态）：

```
dsh plugin --profile desktop add E:\DSAgent\workspace\dsh-confirm-mode
```

或从 Git 仓库安装：

```
dsh plugin --profile desktop add github:<owner>/dsh-confirm-mode
```

安装后确认组合层里出现该插件：

```
dsh --profile desktop --dump-config
```

启动后，输入框工具栏权限下拉框旁边会出现「默认 / 确认模式」开关。

卸载：

```
dsh plugin --profile desktop remove dsh-confirm-mode
```

## 实现要点

- 治理点：`tools/pre-execute`（前置，返回 `{kind:"ask"}`）+ `approval/request`
  （前置，永不自行放行），均按**发起会话**的模式判定，所以不同窗口互不影响。
- 切换模式会通过注入消息通知该会话的代理。
- Host 半不 import 任何带版本号的 `@deepseek-ai/dsh-*` 包，因此不会在新版 DSH
  上被判为不兼容。

## License

MIT
