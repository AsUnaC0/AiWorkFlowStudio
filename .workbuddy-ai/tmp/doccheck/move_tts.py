import io, re

p = r"C:/Users/meibus/Desktop/AI WorkFlow Studio/docs/教程/08-前后端数据对照总表.md"
txt = io.open(p, encoding="utf-8").read()

marker = "### 6.10 ★ TTS 语音合成"
idx = txt.index(marker)
tts_block = txt[idx:].rstrip() + "\n"
head = txt[:idx].rstrip() + "\n"

# 去掉尾部残留的分隔线（TTS 块前是 "---\n\n→ 全书完..."，保持原样即可）
assert "→ 全书完" in head, "全书完锚点丢失"

tts_block = tts_block.replace("### 6.10 ★ TTS 语音合成", "### 6.11 ★ TTS 语音合成", 1)

anchor = "\n---\n\n## 7. 接口覆盖情况"
aidx = head.index(anchor)
new = head[:aidx].rstrip() + "\n\n" + tts_block + "\n" + head[aidx:]

io.open(p, "w", encoding="utf-8", newline="\n").write(new)
print("moved, new length:", len(new.splitlines()))
