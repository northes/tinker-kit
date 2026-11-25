# 把时间工具按页拆成三个工具

状态：已对齐。实现时以本文「已定决策」与「需求条目」为准。

## 背景与目标

现在「时间工具」（`time`）是一个工具，内部用页签切换「时间转换」「日期计算」「真实时间」。转换页负责解析时间戳和日期、结果行、时区和周起始；日期计算是独立的加减和日期间隔；真实时间通过 NTP 对时，并维护多时区时钟。

目标：三个页各自成为独立工具，工具内部不再留页签。剪贴板和托盘只识别时间转换。不把旧的工具 id `time` 迁移成新工具。

## 需求条目

1. 删除工具 id `time`。新增三个工具，默认顺序里占原来 `time` 的位置，彼此顺序为：`time-convert`（时间转换 / Time Converter）、`date-calculator`（日期计算 / Date Calculator）、`real-time`（真实时间 / Real Time）。其后仍是 `text`。
2. 简介：时间转换是「转换时间戳与日期 / Convert timestamps and dates」；日期计算是「计算日期差并做日期加减 / Add, subtract, and compare dates」；真实时间是「通过 NTP 查看真实时间 / View real time from NTP」。图标分别是 Clock、CalendarBlank、GlobeHemisphereWest。中英文一起改。
3. 三个工具各自是完整工具页，使用 `ToolLayout`，不再使用 `ToolLayoutTabs`。时间转换承接现在的转换页（输入、快捷填入、结果行排序与隐藏、时区、周起始）。日期计算承接现在的 `DateCalculator`。真实时间承接现在的 `RealTimePanel`（含 NTP 服务器和多时区时钟）。除去掉页签外，不改这三页的交互。
4. 命令面板有三个打开命令，文案就是三个工具名。原来的「插入当前时间戳」和「使用系统时区」只属于时间转换，命令 id 改为 `time-convert:refresh`、`time-convert:timezone`。日期计算和真实时间不新增动作命令。
5. 剪贴板和托盘识别只打开时间转换，而且该工具须处于启用状态并在托盘识别列表里。日期计算和真实时间不能被剪贴板识别，也不出现在托盘识别的可选工具里。
6. 结果行顺序、隐藏行、周起始仍用现有配置字段 `timeResultOrder`、`hiddenTimeResults`、`timeWeekStart`，只给时间转换用。NTP 服务器仍用 `ntpServers`，只给真实时间用。不改字段名，不因为拆工具清掉已有值。
7. 不写把 `time` 替换成这三个 id、或按它原来的启用状态插回原位的迁移。已有配置里的 `time` 按现有「未知工具 id 丢掉」处理。缺失的默认工具仍按现有规则补到列表末尾并启用，因此未重置时这三项在末尾，不在原来 `time` 的位置。托盘列表仍只保留合法 id，不把 `time-convert` 补进已有列表；列表被滤空时仍回退整份默认列表。要默认工具顺序，或让托盘重新识别时间转换，用重置设置。
8. 新安装和重置后的默认列表里，工具顺序按需求条目 1，托盘识别列表是 `json`、`time-convert`、`text`、`base64`、`diff`、`jwt`、`url`。差异对比关闭剪贴板目标时的回退列表同样把 `time` 换成 `time-convert`，不加入另外两个工具。Go 与前端的默认列表、合法 id 集合必须一致。

## 已定决策

- 工具 id 用 `time-convert`、`date-calculator`、`real-time`。与 `text-generator`、`port-forwards` 一样是短横线小写，并且不再保留含义已经变窄的 `time`。
- 界面上已经没有工具侧栏。工具显隐和排序仍存在配置字段 `sidebarTools` 里，设置页、空白标签和命令面板都读它。这次不改这个字段名，只改其中的工具 id。
- 真实时间用 GlobeHemisphereWest，因为这一页是世界地图加多时区时钟，需要和转换页的 Clock 分开。项目里若没有这个导出，改用 Globe，并在实现说明里写一句。
- 工具目录、打开命令使用新的文案 key。三页内部已有的 `timeTool.*` 句子继续用，不为了换 key 去搬仍在显示的文案。页签文案 `timeTool.modes` 和旧的 `tools.time`、`commands.openTime` 删除。
- 打开命令的关键词按工具拆开，但「时间 / time」仍能命中三个工具。转换保留时间戳、时区、unix；日期计算保留日期、时长、加减、差异；真实时间保留 NTP、时区、真实时间。
- `frontend/src/lib/json-time-format.ts` 里的格式名 `'time'`、`<input type="time">`、图表 `scale="time"` 都不是工具 id，不动。
- 工作区标签测试里把 `time` 当作普通工具 id 的夹具，改成仍然存在的工具 id。不为测试保留 `time`。
- 不改 Go 导出类型，因此不重新生成、也不手改 `frontend/bindings/`。

## 非目标

- 不重做三页的布局、文案和交互，只去掉包在外面的页签。
- 不把 `sidebarTools` 改名，不删除设置页里的工具显隐和排序。
- 不改 `timeResultOrder`、`hiddenTimeResults`、`timeWeekStart`、`ntpServers` 的字段名和规范化，也不清掉已有值。
- 不为 `time` 写专用迁移，也不改 port-forwards 等其它历史迁移。
- 不把日期计算、真实时间加入托盘识别。
- 不新增日期计算或真实时间的命令面板动作。
- 不改 `default-light` / `default-dark`。

## 验收标准

- 工具目录、命令面板和空白标签里不再有「时间工具」。三个新工具的名字、简介、图标和默认顺序与需求条目 1、2 一致，页面内没有页签。
- 识别到时间戳或日期的剪贴板只打开时间转换；日期计算和真实时间不在托盘可选列表里。时间转换被禁用，或不在托盘识别列表里时，不会被打开。
- 时间转换仍能保存结果行顺序、隐藏行和周起始。真实时间仍能保存 NTP 服务器。日期计算没有新的配置字段。
- 已有配置里的 `time` 被丢掉，三个新工具出现在工具列表末尾且为启用，而不是占住原来 `time` 的位置。已有托盘列表里的 `time` 被丢掉，且不会自动变成 `time-convert`。重置设置之后，工具顺序和托盘列表与需求条目 8 一致。
- 命令面板里，插入当前时间戳和使用系统时区只在时间转换下出现，并仍作用于转换页。
- 代码里不再把 `time` 当作工具 id。JSON 时间格式名、`type="time"` 和图表的 time scale 保持原样。
- Go 与前端的默认工具顺序、托盘默认识别列表一致。

## 待定问题

没有。
