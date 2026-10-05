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
      width="min(680px, 94vw)"
      append-to-body
    >
      <div class="auth-detail">
        <div class="detail-row" v-if="data.source">
          <span class="label">{{ $t('authSource') }}</span>
          <span class="value">{{ data.source }}</span>
        </div>
        <div class="detail-row" v-if="has(data.spamScore)">
          <span class="label">{{ $t('authSpamScore') }}</span>
          <span class="value">{{ data.spamScore }}</span>
        </div>

        <!-- ===== SPF ===== -->
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
          <template v-if="data.spf && data.spf.segments && data.spf.segments.length">
            <div class="sub-title">{{ $t('authSegments') }}</div>
            <div class="segment" v-for="(seg, i) in data.spf.segments" :key="i">
              <div class="seg-head">
                <span class="seg-type">{{ seg.type }}</span>
                <span class="seg-value">{{ seg.value || '-' }}</span>
                <span class="seg-result" :class="'result-' + statusClass(seg.result)">{{ resultText(seg.result) }}</span>
              </div>
              <div class="seg-reason" v-if="seg.reason">{{ seg.reason }}</div>
            </div>
          </template>
        </div>

        <!-- ===== DKIM ===== -->
        <div class="detail-section">
          <div class="section-title">
            DKIM
            <span :class="'result-' + statusClass(dkimResult)">{{ resultText(dkimResult) }}</span>
          </div>
          <div class="sig" v-for="(sig, i) in data.dkim || []" :key="i">
            <div class="sig-head">
              #{{ i + 1 }}
              <span :class="'result-' + statusClass(sig.result)">{{ resultText(sig.result) }}</span>
            </div>
            <div class="detail-row" v-if="has(sig.domain)">
              <span class="label">{{ $t('authDomain') }}</span>
              <span class="value">{{ sig.domain }}</span>
            </div>
            <div class="detail-row" v-if="has(sig.selector)">
              <span class="label">{{ $t('authSelector') }}</span>
              <span class="value">{{ sig.selector }}</span>
            </div>
            <div class="detail-row" v-if="has(sig.algorithm)">
              <span class="label">{{ $t('authAlgo') }}</span>
              <span class="value">{{ sig.algorithm }}</span>
            </div>
            <div class="detail-row" v-if="has(sig.canon)">
              <span class="label">{{ $t('authCanon') }}</span>
              <span class="value">{{ sig.canon }}</span>
            </div>
            <div class="detail-row" v-if="has(sig.query)">
              <span class="label">{{ $t('authQuery') }}</span>
              <span class="value">{{ sig.query }}</span>
            </div>
            <div class="detail-row" v-if="has(sig.timestamp)">
              <span class="label">{{ $t('authSignedAt') }}</span>
              <span class="value">{{ formatTimestamp(sig.timestamp) }}</span>
            </div>
            <div class="detail-row" v-if="has(sig.sigHash)">
              <span class="label">{{ $t('authSigHash') }}</span>
              <span class="value mono">{{ sig.sigHash }}</span>
            </div>
            <div class="detail-row" v-if="has(sig.bodyHash)">
              <span class="label">{{ $t('authBodyHash') }}</span>
              <span class="value mono">{{ sig.bodyHash }}</span>
            </div>
            <div class="detail-row" v-if="has(sig.headers)">
              <span class="label">{{ $t('authHeaders') }}</span>
              <span class="value">{{ sig.headers }}</span>
            </div>
          </div>
        </div>

        <!-- ===== DMARC ===== -->
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
          <div class="detail-row" v-if="data.dmarc && has(data.dmarc.spfAligned)">
            <span class="label">{{ $t('authAligned') }}</span>
            <span class="value">
              SPF <span :class="'result-' + (data.dmarc.spfAligned ? 'pass' : 'fail')">{{ data.dmarc.spfAligned ? '✓' : '✗' }}</span>
              &nbsp;|&nbsp;
              DKIM <span :class="'result-' + alignClass(data.dmarc.dkimAligned)">{{ alignIcon(data.dmarc.dkimAligned) }}</span>
            </span>
          </div>
        </div>

        <!-- ===== ARC ===== -->
        <div class="detail-section" v-if="data.arc || (data.arcChain && data.arcChain.length)">
          <div class="section-title">
            ARC
            <span v-if="data.arc" :class="'result-' + statusClass(data.arc)">{{ resultText(data.arc) }}</span>
          </div>
          <div class="arc-item" v-for="link in data.arcChain || []" :key="link.instance">
            <div class="arc-head">
              i={{ link.instance }}
              <template v-if="link.seal"> · d={{ link.seal.d }} · s={{ link.seal.s }} · cv={{ link.seal.cv }}</template>
            </div>
            <div class="arc-aar" v-if="link.aar">{{ link.aar }}</div>
          </div>
        </div>

        <!-- ===== Received 传递路径 ===== -->
        <el-collapse v-if="data.received && data.received.length" class="auth-collapse">
          <el-collapse-item :title="$t('authReceived') + ' (' + data.received.length + ')'">
            <div class="received-item" v-for="(line, i) in data.received" :key="i">{{ line }}</div>
          </el-collapse-item>
        </el-collapse>

        <!-- ===== 原始认证头 ===== -->
        <el-collapse v-if="data.raw" class="auth-collapse">
          <el-collapse-item :title="$t('authRaw')">
            <pre class="raw-box">{{ data.raw }}</pre>
          </el-collapse-item>
        </el-collapse>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'

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

function has(v) {
  return v !== undefined && v !== null && v !== ''
}

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

function alignClass(v) {
  if (v === true) return 'pass'
  if (v === false) return 'fail'
  return 'unknown'
}

function alignIcon(v) {
  if (v === true) return '✓'
  if (v === false) return '✗'
  return '—'
}

function formatTimestamp(ts) {
  if (!ts) return ''
  const n = Number(ts)
  if (!n || isNaN(n)) return String(ts)
  return dayjs.unix(n).format('YYYY-MM-DD HH:mm:ss')
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
      min-width: 88px;
      flex-shrink: 0;
    }

    .value {
      color: var(--el-text-color-primary);
      word-break: break-all;

      &.mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
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

    .sub-title {
      margin-top: 8px;
      margin-bottom: 4px;
      color: var(--secondary-text-color);
      font-size: 12px;
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

  .segment {
    margin: 6px 0;
    padding: 6px 8px;
    background: var(--light-ill);
    border-radius: 4px;

    .seg-head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;

      .seg-type {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        padding: 0 6px;
        border-radius: 3px;
        background: var(--base-fill);
        color: var(--regular-text-color);
      }

      .seg-value {
        word-break: break-all;
        flex: 1;
        min-width: 120px;
      }

      .seg-result {
        font-weight: 600;
        flex-shrink: 0;
      }
    }

    .seg-reason {
      margin-top: 4px;
      font-size: 12px;
      color: var(--secondary-text-color);
      word-break: break-all;
    }
  }

  .sig {
    margin: 8px 0;
    padding: 8px 10px;
    border: 1px solid var(--light-border-color);
    border-radius: 4px;

    .sig-head {
      font-weight: 600;
      margin-bottom: 4px;
      display: flex;
      gap: 6px;
    }
  }

  .arc-item {
    margin: 6px 0;
    padding: 6px 8px;
    background: var(--light-ill);
    border-radius: 4px;

    .arc-head {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: var(--regular-text-color);
      word-break: break-all;
    }

    .arc-aar {
      margin-top: 4px;
      font-size: 12px;
      color: var(--secondary-text-color);
      word-break: break-all;
    }
  }

  .auth-collapse {
    margin-top: 10px;
    border-top: 1px solid var(--light-border-color);
    padding-top: 4px;
  }

  .received-item {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    color: var(--regular-text-color);
    word-break: break-all;
    padding: 4px 0;
    border-bottom: 1px dashed var(--light-border-color);

    &:last-child {
      border-bottom: none;
    }
  }

  .raw-box {
    max-height: 300px;
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
