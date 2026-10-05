<template>
  <div class="auth-box" v-if="data">
    <span class="auth-title">{{ $t('authCheck') }}</span>
    <span
      v-for="item in badges"
      :key="item.name"
      class="auth-tag"
      :class="item.status"
      @click="showDetail = true"
    >
      {{ item.name }} {{ item.icon }}
    </span>

    <el-dialog
      v-model="showDetail"
      :title="$t('authDetailTitle')"
      width="min(620px, 94vw)"
      append-to-body
    >
      <div class="auth-detail">
        <div class="detail-row" v-if="data.source">
          <span class="label">{{ $t('authSource') }}</span>
          <span class="value">{{ data.source }}</span>
        </div>

        <div class="detail-section">
          <div class="section-title">
            SPF
            <span :class="'result-' + statusClass(data.spf && data.spf.result)">{{ resultText(data.spf && data.spf.result) }}</span>
          </div>
          <div class="detail-row" v-if="data.spf && data.spf.ip">
            <span class="label">{{ $t('authSenderIp') }}</span>
            <span class="value">{{ data.spf.ip }}</span>
          </div>
          <div class="detail-row" v-if="data.spf && data.spf.mailfrom">
            <span class="label">{{ $t('authMailfrom') }}</span>
            <span class="value">{{ data.spf.mailfrom }}</span>
          </div>
          <div class="detail-row" v-if="data.spf && data.spf.helo">
            <span class="label">HELO</span>
            <span class="value">{{ data.spf.helo }}</span>
          </div>
        </div>

        <div class="detail-section">
          <div class="section-title">
            DKIM
            <span :class="'result-' + statusClass(dkimResult)">{{ resultText(dkimResult) }}</span>
          </div>
          <div class="detail-row" v-for="(sig, i) in data.dkim || []" :key="i">
            <span class="label">#{{ i + 1 }} {{ resultText(sig.result) }}</span>
            <span class="value">
              <template v-if="sig.domain">{{ $t('authDomain') }}: {{ sig.domain }}</template>
              <template v-if="sig.selector">{{ sig.domain ? ' | ' : '' }}{{ $t('authSelector') }}: {{ sig.selector }}</template>
              <template v-if="!sig.domain && !sig.selector">-</template>
            </span>
          </div>
        </div>

        <div class="detail-section">
          <div class="section-title">
            DMARC
            <span :class="'result-' + statusClass(data.dmarc && data.dmarc.result)">{{ resultText(data.dmarc && data.dmarc.result) }}</span>
          </div>
          <div class="detail-row" v-if="data.dmarc && data.dmarc.from">
            <span class="label">{{ $t('authDmarcFrom') }}</span>
            <span class="value">{{ data.dmarc.from }}</span>
          </div>
          <div class="detail-row" v-if="data.dmarc && data.dmarc.policy">
            <span class="label">{{ $t('authPolicy') }}</span>
            <span class="value">{{ data.dmarc.policy }}</span>
          </div>
        </div>

        <div class="detail-section" v-if="data.arc">
          <div class="section-title">
            ARC
            <span :class="'result-' + statusClass(data.arc)">{{ resultText(data.arc) }}</span>
          </div>
        </div>

        <div class="detail-section" v-if="data.raw">
          <div class="section-title">{{ $t('authRaw') }}</div>
          <pre class="raw-box">{{ data.raw }}</pre>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  authResults: {
    type: String,
    default: ''
  }
})

const { t } = useI18n()
const showDetail = ref(false)

const data = computed(() => {
  if (!props.authResults) return null
  try {
    const d = typeof props.authResults === 'string' ? JSON.parse(props.authResults) : props.authResults
    return d && (d.spf || d.dkim || d.dmarc) ? d : null
  } catch (e) {
    return null
  }
})

const dkimResult = computed(() => {
  const list = (data.value && data.value.dkim) || []
  if (list.length === 0) return ''
  if (list.some(d => isFail(d.result))) return 'fail'
  if (list.every(d => d.result === 'pass')) return 'pass'
  return list[0].result || ''
})

function isFail(result) {
  return ['fail', 'softfail', 'hardfail', 'policy'].includes(result)
}

function statusClass(result) {
  if (result === 'pass') return 'pass'
  if (isFail(result)) return 'fail'
  return 'unknown'
}

function resultText(result) {
  if (!result) return t('authUnknown')
  if (result === 'pass') return t('authPass')
  if (isFail(result)) return t('authFail')
  return result
}

function icon(result) {
  const s = statusClass(result)
  if (s === 'pass') return '✓'
  if (s === 'fail') return '✗'
  return '?'
}

const badges = computed(() => {
  const d = data.value
  if (!d) return []
  return [
    { name: 'SPF', status: statusClass(d.spf && d.spf.result), icon: icon(d.spf && d.spf.result) },
    { name: 'DKIM', status: statusClass(dkimResult.value), icon: icon(dkimResult.value) },
    { name: 'DMARC', status: statusClass(d.dmarc && d.dmarc.result), icon: icon(d.dmarc && d.dmarc.result) }
  ]
})
</script>

<style scoped lang="scss">
.auth-box {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;

  .auth-title {
    color: var(--secondary-text-color);
  }

  .auth-tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 8px;
    height: 20px;
    line-height: 1;
    border-radius: 10px;
    border: 1px solid transparent;
    cursor: pointer;
    user-select: none;
    transition: filter 0.15s;

    &:hover {
      filter: brightness(0.95);
    }

    &.pass {
      color: #16a34a;
      border-color: rgba(22, 163, 74, 0.4);
      background: rgba(22, 163, 74, 0.1);
    }

    &.fail {
      color: #dc2626;
      border-color: rgba(220, 38, 38, 0.4);
      background: rgba(220, 38, 38, 0.1);
    }

    &.unknown {
      color: var(--secondary-text-color);
      border-color: var(--light-border-color);
      background: var(--light-ill);
    }
  }
}

:global(.dark) .auth-box .auth-tag {
  &.pass {
    color: #4ade80;
    border-color: rgba(74, 222, 128, 0.4);
    background: rgba(74, 222, 128, 0.12);
  }

  &.fail {
    color: #f87171;
    border-color: rgba(248, 113, 113, 0.4);
    background: rgba(248, 113, 113, 0.12);
  }
}

.auth-detail {
  font-size: 13px;

  .detail-row {
    display: flex;
    gap: 8px;
    margin: 4px 0;

    .label {
      color: var(--secondary-text-color);
      white-space: nowrap;
      min-width: 72px;
    }

    .value {
      color: var(--el-text-color-primary);
      word-break: break-all;
    }
  }

  .detail-section {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--light-border-color);

    &:first-child {
      margin-top: 0;
      border-top: none;
      padding-top: 0;
    }

    .section-title {
      font-weight: 600;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
  }

  .result-pass {
    color: #16a34a;
  }

  .result-fail {
    color: #dc2626;
  }

  .result-unknown {
    color: var(--secondary-text-color);
  }

  .raw-box {
    max-height: 260px;
    overflow: auto;
    background: var(--light-ill);
    border-radius: 4px;
    padding: 8px;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    color: var(--regular-text-color);
  }
}

:global(.dark) .auth-detail {
  .result-pass {
    color: #4ade80;
  }

  .result-fail {
    color: #f87171;
  }
}
</style>
