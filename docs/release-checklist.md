# Release Checklist

用于准备 `mud-pi` 的公开版本。正式创建 Tag 和 GitHub Release 前逐项确认。

## 1. 范围与版本

- [ ] `package.json` 版本与目标 Tag 一致；
- [ ] `CHANGELOG.md` 已更新日期、功能和已知限制；
- [ ] 本次提交只包含可公开内容；
- [ ] 没有把计划中的功能描述成已经实现；
- [ ] breaking change 已说明存档和世界包迁移方式。

## 2. 仓库卫生

```bash
git status --short
git diff --check
git ls-files | grep -E '(^|/)(\.env|saves|node_modules)(/|$)|pi-session.*\.(jsonl|html)$'
```

- [ ] 工作区干净；
- [ ] `.env`、存档、Session、日志和 token 未跟踪；
- [ ] 没有真实用户数据或本地绝对路径；
- [ ] 没有 API key、OAuth token、cookie、私钥或 Authorization header；
- [ ] 新增世界内容具有公开发布权利和兼容许可证。

## 3. 自动验证

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
git diff --check
```

- [ ] TypeScript 检查通过；
- [ ] 全部测试通过；
- [ ] 没有依赖真实付费 Provider 的测试；
- [ ] 所有内置世界包通过 Validator。

## 4. 干净 Clone

在仓库外执行：

```bash
rm -rf /tmp/mud-pi-release-smoke
git clone --depth 1 https://github.com/DrayChou/mud-pi.git /tmp/mud-pi-release-smoke
cd /tmp/mud-pi-release-smoke
bun install --frozen-lockfile
bun run typecheck
bun test
```

- [ ] clone 不依赖未提交文件；
- [ ] 安装不修改 lockfile；
- [ ] README 的启动命令有效；
- [ ] Web 首页和 `/api/worlds` 可访问；
- [ ] 未配置 AI 时错误信息可理解；
- [ ] 已配置 Pi/Codex 时至少完成一次开场 smoke test。

## 5. 文档

- [ ] README 的功能、命令、默认端口和配置准确；
- [ ] `docs/README.md` 本地链接有效；
- [ ] `SECURITY.md` 与当前安全边界一致；
- [ ] `CONTRIBUTING.md` 的质量门可执行；
- [ ] 世界包字段变化同步更新 `docs/world-pack-guide.md`；
- [ ] 已知部署限制没有被省略。

## 6. 手动体验

至少选择一个公开示例世界：

- [ ] CLI 可以创建角色并完成开场；
- [ ] Web 可以创建、输入、刷新并恢复会话；
- [ ] 精确快捷命令不需要无意义 AI 等待；
- [ ] 自然语言 unresolved intent 能进入 Pi；
- [ ] 保存和恢复后位置、背包、Objective 和 Session 连续；
- [ ] Provider 超时不会损坏 committed state。

## 7. Tag 与发布

最终提交完成后：

```bash
git tag -a vX.Y.Z -m "mud-pi vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

- [ ] Tag 指向预期提交；
- [ ] Tag message 不包含内部任务信息；
- [ ] GitHub Release 标为 Alpha/Pre-release（如适用）；
- [ ] Release notes 包含安装、主要能力、安全边界和已知限制；
- [ ] 发布后从 Tag 再做一次浅 clone 验证。

## 8. 发布后

- [ ] 检查 GitHub 默认分支和 Tag；
- [ ] 检查 README、链接和 Release 页面；
- [ ] 新 Bug 记录到 `Unreleased`；
- [ ] 安全问题按 `SECURITY.md` 私下处理；
- [ ] 不修改已发布 Tag；修复通过新 patch 版本发布。
