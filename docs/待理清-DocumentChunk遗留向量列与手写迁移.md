# 待理清：DocumentChunk 遗留向量列 & 手写迁移

> 状态：**待理清（仅记录疑问，未下结论）**
> 记录日期：2026-10-29
> 原文出处：[01-项目架构与入口.md](./后端代码逻辑/01-项目架构与入口.md#L205-L210) 第四节末尾

## 一、原文

> ⚠️ **遗留列**：`DocumentChunk` 上仍保留一个旧版 `embedding vector(768)?` 列（`Unsupported` 类型，由手写迁移维护，
> 对应 IVFFlat 索引 `dc_embedding_ivf`）。新写入的向量都进版本物理表，这个列**只是遗留、不再被新代码写入**，
> 别看到它就以为向量还挂在 chunk 上。
>
> ⚠️ 迁移是**手写 SQL**（`prisma/migrations/<timestamp>_xxx/migration.sql` → `npx prisma migrate deploy` → `npx prisma generate`），
> **不要用 `prisma migrate dev`** —— 它会把 pgvector 的 IVFFlat 索引当「多余对象」生成 `DROP INDEX` 删掉（见 11 第十节）。

这两段话我能看懂字面意思，但落到「为什么这样设计、边界在哪、以后怎么操作」时仍有下面这些疑问。

---

## 二、疑问一：`DocumentChunk.embedding` 这个「遗留列」

### 2.1 我目前的理解（不一定对）

- 文本块存在 `DocumentChunk`；向量按版本存在 `EmbeddingVector_<versionId>` 物理表。
- 旧列 `DocumentChunk.embedding` 是早期「向量直接挂在 chunk 上」的产物，新链路应该不再使用它。
- 索引 `dc_embedding_ivf` 是给这一列建的 IVFFlat 索引。

### 2.2 具体不解

1. **既然「不再被新代码写入」，为什么还要保留这一列？**
   直接删列会带来什么后果？是因为还有历史数据 / 回滚依赖，还是单纯「删了怕出事」？
   迁移注释里写「旧列原样保留，便于回滚」（[migration.sql](../backend/prisma/migrations/20261015143000_model_capabilities_and_embedding_versions/migration.sql#L120)），
   这里的「回滚」具体指回滚什么场景？

2. **为什么连 IVFFlat 索引也保留？**
   如果这一列对新数据永远是 `NULL`，索引上几乎没有有效数据，保留它的意义是什么？
   文档又说 IVFFlat 在空表 / 小表上召回率很低、后续建议改 HNSW ——
   那这个「遗留索引」到底是在等数据量增长，还是只是迁移历史的残留？

3. **「由手写迁移维护」到底指维护什么？**
   是指「建列 + 建索引」这两句 SQL，还是指后续每次有新迁移都要顺带把这句 `CREATE INDEX IF NOT EXISTS` 补回去？
   我需要一份明确的「哪些迁移文件在维护它」的清单。

4. **这一列真的完全没人读了吗？**
   我在代码里看到至少三处仍在碰它：
   - `VectorStoreService.updateEmbedding()` / `updateEmbeddingBatch()` 仍在 `UPDATE "DocumentChunk" SET "embedding" = ...`，见
     [vector-store.service.ts](../backend/src/knowledge/vector/vector-store.service.ts#L45-L75)；
   - `VectorStoreService.vectorSearch()` 仍按 `dc."embedding" <=>` 检索，见
     [vector-store.service.ts](../backend/src/knowledge/vector/vector-store.service.ts#L85-L112)；
   - `KnowledgeRetrievalService.searchForQuery()` 有「尚未建立向量版本时，沿用旧的 `DocumentChunk.embedding` 列」的兜底分支，见
     [knowledge-retrieval.service.ts](../backend/src/knowledge/retrieval/knowledge-retrieval.service.ts#L270-L284)。

   那么「不再被新代码写入」是否准确？还是说「写入方法还在、但已经没人调用」？
   如果旧列对新文档是空的，这个兜底分支实际会不会返回空结果？

5. **`Unsupported("vector(768)")?` 到底让 Prisma 承认了什么？**
   教程说它「承认列存在，但生成的 TypeScript 客户端里没有字段类型，读写只能靠裸 SQL」
   （[01-从零搭建运行环境.md](./教程/01-从零搭建运行环境.md#L380-L391)）。
   那这一列在 Prisma Client 层面算「可见」还是「不可见」？
   「不写它」是设计约束，还是类型系统根本写不了？

6. **新旧数据的一致性怎么保证？**
   迁移把旧向量搬进 v1 物理表，但旧列继续保留。之后如果物理表里的向量被重算 / 更新，
   旧列不会同步。那两处数据出现分歧时，以谁为准？旧列的过期数据会不会被兜底逻辑读到？

7. **这一列的「退休条件」是什么？**
   什么情况下可以安全地 `DROP COLUMN` + `DROP INDEX`？需要先满足哪些条件（例如所有知识库都有激活版本、旧数据已备份）？

---

## 三、疑问二：为什么必须「手写 SQL + migrate deploy」，而不能用 `migrate dev`

### 3.1 我目前的理解（不一定对）

- `prisma migrate dev` 会对比 `schema.prisma` 与数据库，把数据库里「schema 没声明」的对象视为多余。
- 向量索引无法在 `schema.prisma` 里声明，所以 `migrate dev` 会生成 `DROP INDEX "dc_embedding_ivf"`。
- 因此项目约定：迁移文件手写，再用 `migrate deploy` 应用。

### 3.2 具体不解

1. **为什么列保住了，索引却保不住？**
   列已经用 `Unsupported("vector(768)")?` 占位（[schema.prisma](../backend/prisma/schema.prisma#L284-L315)），
   所以 `migrate dev` 不再生成 `DROP COLUMN`；但索引没有任何声明位置，于是被当成多余对象。
   这个解释是否完整？Prisma 7 是否真的完全没有声明 `ivfflat` / `hnsw` 索引的语法或 preview 能力？

2. **`migrate deploy` 为什么不会做同样的「多余对象」判断？**
   我的理解是：`deploy` 只按顺序执行 `migrations/` 里尚未应用的 SQL，不与 `schema.prisma` 做 diff；
   而 `dev` 会做 diff / drift 检测。这个理解对吗？如果是，`deploy` 是否也就不会检查「库里有、schema 没有」的对象？

3. **手写迁移的标准流程到底是哪一套？**
   我至少看到三种说法：
   - 01 说「手写 `migration.sql` → `migrate deploy` → `generate`」；
   - `schema.prisma` 注释说「用 `migrate dev --create-only` 生成后检查并删掉 DROP 语句」；
   - `20261015143000` 迁移注释说「由 `prisma migrate diff --from-config-datasource --to-schema` 生成后手工整理」。

   这三种方式各适用于什么场景？`--create-only` 和 `migrate diff` 是否也会触发同样的索引问题？
   如果我要新增一张普通表，正确动作是手写整段 SQL，还是先 diff 再改？

4. **手写迁移的「校验」机制是什么？**
   `migrate deploy` 是否会校验 migration 文件的 checksum？
   如果一条手写迁移已经应用过、之后又被人改动，会发生什么（报 drift / 校验失败 / 静默不生效）？
   「可以改」和「绝不能改」的边界在哪？

5. **`migrate dev` 的 shadow database 在这里扮演什么角色？**
   它会不会把已有迁移重放到影子库？如果影子库没有 `vector` 扩展，是否会直接失败？
   这和「生成 `DROP INDEX`」是同一件事，还是另一件独立的事？

6. **项目里的命令本身是矛盾的？**
   `backend/package.json` 里 `prisma:migrate` 仍然指向 `prisma migrate dev`
   （[package.json](../backend/package.json#L23)），但 01 和 [命令.md](./命令.md#L28-L42) 都写「不要用」。
   这是历史遗留没改，还是「脚本可以用、但要人工检查 SQL」？
   同时教程又说「开发期用 `migrate dev`，跑完检查 SQL」（[01-从零搭建运行环境.md](./教程/01-从零搭建运行环境.md#L260-L262)）——
   到底哪份文档是当前权威口径？

7. **全新环境怎么复现「31 张表 + 每版本一张物理向量表」？**
   物理向量表是运行时由 `EmbeddingVersionService` 建的（不在迁移里），
   那么新环境只跑 `migrate deploy` 时，`DocumentChunk.embedding` 和 `dc_embedding_ivf` 是否一定会被建出来？
   依赖哪几条迁移的先后顺序？

8. **「见 11 第十节」这个引用准确吗？**
   11 的第十节是「最容易踩的坑」，其中第 7 条才是迁移约定
   （[11-平台助理.md](./后端代码逻辑/11-平台助理.md#L397-L401)）。
   原文只写「第十节」，容易让人以为整节都在讲迁移。

---

## 四、已经定位到的证据（供后续核实，不作为结论）

| 主题 | 位置 |
|---|---|
| `DocumentChunk` 模型与 `embedding` 声明 | [schema.prisma](../backend/prisma/schema.prisma#L284-L315) |
| 新链路写入版本物理表 | [document.processor.ts](../backend/src/queues/document-processing/document.processor.ts#L170)、[embedding-version.service.ts](../backend/src/knowledge/embedding/embedding-version.service.ts#L277-L320) |
| 旧列仍有写入方法（但未查到调用方） | [vector-store.service.ts](../backend/src/knowledge/vector/vector-store.service.ts#L45-L75) |
| 旧列仍有检索 / 兜底读取 | [vector-store.service.ts](../backend/src/knowledge/vector/vector-store.service.ts#L85-L112)、[knowledge-retrieval.service.ts](../backend/src/knowledge/retrieval/knowledge-retrieval.service.ts#L270-L284) |
| 建列 + 建 IVFFlat 索引的原始迁移 | [20260923130000_add_pgvector_embedding](../backend/prisma/migrations/20260923130000_add_pgvector_embedding/migration.sql) |
| 被误删后恢复索引的迁移 | [20261013104000_restore_dc_embedding_ivf](../backend/prisma/migrations/20261013104000_restore_dc_embedding_ivf/migration.sql#L1-L31) |
| 版本化迁移中「保留旧列便于回滚」+ 搬运旧向量 | [20261015143000](../backend/prisma/migrations/20261015143000_model_capabilities_and_embedding_versions/migration.sql#L3-L6)、[同文件 L120-L144](../backend/prisma/migrations/20261015143000_model_capabilities_and_embedding_versions/migration.sql#L120-L144) |
| 文档中的迁移约定 | [命令.md](./命令.md#L28-L46)、[01-项目架构与入口.md](./后端代码逻辑/01-项目架构与入口.md#L205-L210) |

---

## 五、建议的核实动作（只读，不改库）

> 先做只读确认，再决定是否动列 / 索引。

1. **看迁移状态**：`npx prisma migrate status`（确认有无未应用迁移 / drift）。
2. **看 diff 会不会再生成 DROP**：先 `npx prisma migrate diff --help` 确认 Prisma 7 的参数名，
   再用「只输出脚本、不执行」的模式生成一份 diff，检查是否出现 `DROP INDEX "dc_embedding_ivf"`。
3. **看库里真实状态**：
   - `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'DocumentChunk';`
   - 统计 `DocumentChunk.embedding IS NOT NULL` 的行数，以及这些 chunk 属于哪些知识库。
4. **看调用链**：全局搜索 `updateEmbedding(` / `updateEmbeddingBatch(` / `vectorSearch(`，
   确认旧写入方法是否真的没有调用方，旧检索是否只在「无激活版本」时触发。
5. **看迁移历史表**：检查 `_prisma_migrations` 里各条手写迁移的 checksum 与应用时间，
   确认是否存在「应用后被改过」的迁移。

---

## 六、理清标准（能回答这些就算理清）

- [ ] 能明确说明旧列 / 旧索引「留」的具体收益，以及「删」的前置条件。
- [ ] 能列出所有仍在读写 `DocumentChunk.embedding` 的代码路径，并判定它们是死代码还是兜底逻辑。
- [ ] 能说明旧列与新物理表不一致时，检索实际走哪条路径、会不会读到过期数据。
- [ ] 能说明 `migrate dev` 与 `migrate deploy` 在「对象多余判断 / drift / shadow DB / checksum」上的具体差异。
- [ ] 能给出唯一权威的新迁移流程（命令、生成方式、检查项、回滚方式），并与 `package.json` 脚本口径对齐。
- [ ] 能在全新库上按文档跑通一次迁移，并验证列与索引都存在。

---

## 七、相关文档

- [01-项目架构与入口.md](./后端代码逻辑/01-项目架构与入口.md) 第四节
- [06-知识库与RAG.md](./后端代码逻辑/06-知识库与RAG.md) §六 向量版本化
- [11-平台助理.md](./后端代码逻辑/11-平台助理.md) 第十节第 7 条
- [命令.md](./命令.md) 「执行 Migration」
- [01-从零搭建运行环境.md](./教程/01-从零搭建运行环境.md) §5.1–§5.2
- [07-后端知识库与RAG.md](./教程/07-后端知识库与RAG.md) 关于 `embedding` 列的踩坑表
