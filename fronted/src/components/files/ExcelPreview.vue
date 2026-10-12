<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { FilePreviewPayload, PreviewSheet } from "@/types/files";

/**
 * Excel / CSV 预览。
 * 后端用 exceljs 读取工作簿，返回结构化的工作表数据；前端渲染为可切换的表格。
 */
const props = defineProps<{ payload: FilePreviewPayload }>();

const sheets = computed<PreviewSheet[]>(() => props.payload.sheets ?? []);
const activeIndex = ref(0);

watch(
  () => props.payload.id,
  () => {
    activeIndex.value = 0;
  },
);

const activeSheet = computed<PreviewSheet | null>(
  () => sheets.value[activeIndex.value] ?? null,
);

const columns = computed(() =>
  (activeSheet.value?.headers ?? []).map((title, index) => ({
    colKey: String(index),
    title: title || `列 ${index + 1}`,
  })),
);

const data = computed(() =>
  (activeSheet.value?.rows ?? []).map((row, rowIndex) => {
    const record: Record<string, string> = { __index: String(rowIndex + 1) };
    (activeSheet.value?.headers ?? []).forEach((_, colIndex) => {
      record[String(colIndex)] = row?.[colIndex] ?? "";
    });
    return record;
  }),
);

const displayColumns = computed(() => [
  { colKey: "__index", title: "#", width: 56 },
  ...columns.value,
]);
</script>

<template>
  <div class="excel-preview">
    <div v-if="sheets.length > 1" class="sheet-tabs">
      <button
        v-for="(sheet, index) in sheets"
        :key="sheet.name + index"
        class="sheet-tab"
        :class="{ active: index === activeIndex }"
        @click="activeIndex = index"
      >
        {{ sheet.name }}
      </button>
    </div>

    <div v-if="!activeSheet || data.length === 0" class="empty">
      该工作表暂无数据
    </div>

    <template v-else>
      <div class="sheet-meta">
        <span>{{ activeSheet.name }}</span>
        <span class="dim">{{ data.length }} 行 × {{ columns.length }} 列</span>
        <t-tag v-if="activeSheet.truncated" theme="warning" variant="light" size="small">
          已截断预览
        </t-tag>
      </div>

      <div class="table-wrap">
        <table class="sheet-table">
          <thead>
            <tr>
              <th v-for="col in displayColumns" :key="col.colKey">{{ col.title }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in data" :key="row.__index">
              <td v-for="col in displayColumns" :key="col.colKey">{{ row[col.colKey] ?? "" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped lang="less">
.excel-preview {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sheet-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  border-bottom: 1px solid #e8eaf0;
  padding-bottom: 8px;
}

.sheet-tab {
  padding: 4px 12px;
  border: 1px solid #e8eaf0;
  background: transparent;
  border-radius: 6px;
  font-size: 12px;
  color: #71717a;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    border-color: #7c5cfc;
    color: #7c5cfc;
  }

  &.active {
    background: #ede9fe;
    border-color: #7c5cfc;
    color: #7c5cfc;
    font-weight: 600;
  }
}

.sheet-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #18181b;

  .dim {
    color: #a1a1aa;
  }
}

.table-wrap {
  max-height: 52vh;
  overflow: auto;
  border: 1px solid #e8eaf0;
  border-radius: 8px;
}

.sheet-table {
  border-collapse: collapse;
  font-size: 12.5px;
  width: max-content;
  min-width: 100%;

  th,
  td {
    border: 1px solid #e8eaf0;
    padding: 6px 10px;
    text-align: left;
    white-space: nowrap;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  thead th {
    position: sticky;
    top: 0;
    background: #f7f8fa;
    font-weight: 600;
    z-index: 1;
  }

  tbody tr:nth-child(even) {
    background: #fafafa;
  }
}

.empty {
  padding: 32px 0;
  text-align: center;
  color: #a1a1aa;
  font-size: 13px;
}
</style>
