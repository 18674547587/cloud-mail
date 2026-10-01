<template>
  <div class="log-page">
    <!-- 顶部标题与操作 -->
    <div class="page-header">
      <div class="title">{{ $t('logs') }}</div>
      <div class="actions">
        <span class="auto-refresh">
          <el-switch v-model="autoRefresh" size="small"/>
          <span class="label">{{ $t('autoRefreshLog') }}</span>
        </span>
        <el-button size="small" @click="refreshAll">
          <Icon icon="mdi:refresh" width="16" height="16"/>
        </el-button>
        <el-button size="small" type="primary" v-perm="'log:query'" @click="openConfig">
          <Icon icon="fluent:settings-48-regular" width="16" height="16"/>
        </el-button>
      </div>
    </div>

    <el-tabs v-model="activeTab" class="log-tabs">
      <!-- ==================== 请求明细（Analytics Engine） ==================== -->
      <el-tab-pane :label="$t('reqLog')" name="req">
        <div class="filters">
          <el-input v-model="reqFilter.keyword" :placeholder="$t('keywordPlaceholder')" clearable size="small"
                    class="w200" @keyup.enter="searchReq"/>
          <el-select v-model="reqFilter.method" clearable size="small" class="w100" :placeholder="$t('method')">
            <el-option label="GET" value="GET"/>
            <el-option label="POST" value="POST"/>
            <el-option label="PUT" value="PUT"/>
            <el-option label="DELETE" value="DELETE"/>
          </el-select>
          <el-input v-model="reqFilter.pathPrefix" placeholder="/email" clearable size="small" class="w130"
                    @keyup.enter="searchReq"/>
          <el-checkbox v-model="reqFilter.onlyError" size="small">{{ $t('onlyError') }}</el-checkbox>
          <el-date-picker v-model="reqFilter.timeRange" type="datetimerange" size="small"
                          :start-placeholder="$t('startTime')" :end-placeholder="$t('endTime')"
                          value-format="YYYY-MM-DD HH:mm:ss" class="w330"/>
          <el-button size="small" type="primary" @click="searchReq">{{ $t('query') }}</el-button>
          <el-button size="small" @click="resetReq">{{ $t('reset') }}</el-button>
        </div>

        <div class="log-error" v-if="reqError">
          <Icon icon="mdi:alert-circle-outline" width="15" height="15"/>
          <span>{{ reqError }}</span>
        </div>

        <div class="overview" v-if="reqOverview">
          <span>{{ $t('total') }}: <b>{{ reqOverview.total || 0 }}</b></span>
          <span>{{ $t('errors') }}: <b class="err">{{ reqOverview.errors || 0 }}</b></span>
          <span>{{ $t('avgDuration') }}: <b>{{ Math.round(reqOverview.avg_duration || 0) }} ms</b></span>
          <span>{{ $t('maxDuration') }}: <b>{{ Math.round(reqOverview.max_duration || 0) }} ms</b></span>
        </div>

        <el-table :data="reqRows" size="small" v-loading="reqLoading" @row-click="openReqDetail"
                  class="log-table" height="calc(100vh - 380px)">
          <el-table-column prop="time" :label="$t('time')" width="170"/>
          <el-table-column prop="method" :label="$t('method')" width="80"/>
          <el-table-column prop="path" :label="$t('path')" min-width="200" show-overflow-tooltip/>
          <el-table-column :label="$t('status')" width="80">
            <template #default="{row}">
              <span :class="statusClass(row.status)">{{ row.status }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="$t('duration')" width="90">
            <template #default="{row}">{{ Math.round(row.duration) }} ms</template>
          </el-table-column>
          <el-table-column prop="user_email" :label="$t('user')" width="180" show-overflow-tooltip/>
          <el-table-column prop="ip" :label="'IP'" width="130"/>
          <el-table-column prop="country" :label="$t('region')" width="70"/>
          <el-table-column prop="action" :label="$t('action')" width="140" show-overflow-tooltip/>
        </el-table>

        <div class="pager">
          <el-button size="small" :disabled="!cursorStack.length" @click="reqPrev">{{ $t('prevPage') }}</el-button>
          <span class="page-info">{{ $t('cursorPagingTip') }}</span>
          <el-button size="small" :disabled="!nextCursor" @click="reqNext">{{ $t('nextPage') }}</el-button>
        </div>
      </el-tab-pane>

      <!-- ==================== 审计日志（D1） ==================== -->
      <el-tab-pane :label="$t('auditLog')" name="audit">
        <div class="filters">
          <el-input v-model="auditFilter.keyword" :placeholder="$t('keywordPlaceholder')" clearable size="small"
                    class="w200" @keyup.enter="searchAudit"/>
          <el-select v-model="auditFilter.action" clearable size="small" class="w150" :placeholder="$t('action')">
            <el-option v-for="a in actionOptions" :key="a" :label="a" :value="a"/>
          </el-select>
          <el-select v-model="auditFilter.module" clearable size="small" class="w130" :placeholder="$t('module')">
            <el-option v-for="m in moduleOptions" :key="m" :label="m" :value="m"/>
          </el-select>
          <el-date-picker v-model="auditFilter.timeRange" type="datetimerange" size="small"
                          :start-placeholder="$t('startTime')" :end-placeholder="$t('endTime')"
                          value-format="YYYY-MM-DD HH:mm:ss" class="w330"/>
          <el-button size="small" type="primary" @click="searchAudit">{{ $t('query') }}</el-button>
          <el-button size="small" @click="resetAudit">{{ $t('reset') }}</el-button>
          <el-button size="small" v-perm="'log:export'" @click="exportAudit">
            <Icon icon="material-symbols:download-rounded" width="15" height="15"/>{{ $t('exportCsv') }}
          </el-button>
          <el-button size="small" type="danger" v-perm="'log:delete'" @click="clearAudit">{{ $t('clearLog') }}</el-button>
        </div>

        <div class="log-error" v-if="auditError">
          <Icon icon="mdi:alert-circle-outline" width="15" height="15"/>
          <span>{{ auditError }}</span>
        </div>

        <el-table :data="auditRows" size="small" v-loading="auditLoading" @row-click="openAuditDetail"
                  class="log-table" height="calc(100vh - 380px)">
          <el-table-column prop="created_at" :label="$t('time')" width="180">
            <template #default="{row}">{{ formatTime(row.created_at) }}</template>
          </el-table-column>
          <el-table-column prop="user_email" :label="$t('user')" width="180" show-overflow-tooltip/>
          <el-table-column prop="action" :label="$t('action')" width="160"/>
          <el-table-column prop="module" :label="$t('module')" width="100"/>
          <el-table-column prop="method" :label="$t('method')" width="80"/>
          <el-table-column prop="path" :label="$t('path')" min-width="180" show-overflow-tooltip/>
          <el-table-column :label="$t('status')" width="80">
            <template #default="{row}">
              <span :class="statusClass(row.status)">{{ row.status }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="ip" :label="'IP'" width="130"/>
        </el-table>

        <div class="pager">
          <el-pagination
              size="small"
              background
              layout="total, prev, pager, next, sizes"
              :total="auditTotal"
              v-model:current-page="auditFilter.pageNum"
              v-model:page-size="auditFilter.pageSize"
              :page-sizes="[20, 50, 100]"
              @current-change="loadAudit"
              @size-change="searchAudit"
          />
        </div>
      </el-tab-pane>

      <!-- ==================== 统计趋势 ==================== -->
      <el-tab-pane :label="$t('logStat')" name="stat">
        <div class="filters">
          <el-select v-model="statDays" size="small" class="w130" @change="loadStat">
            <el-option :label="$t('last7Days')" :value="7"/>
            <el-option :label="$t('last30Days')" :value="30"/>
            <el-option :label="$t('last90Days')" :value="90"/>
          </el-select>
          <el-button size="small" @click="loadStat">{{ $t('refresh') }}</el-button>
          <span class="tip">{{ $t('statTip') }}</span>
        </div>

        <div class="log-error" v-if="statError">
          <Icon icon="mdi:alert-circle-outline" width="15" height="15"/>
          <span>{{ statError }}</span>
        </div>

        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-title">{{ $t('dailyTrend') }}</div>
            <el-table :data="statRows" size="small" height="300">
              <el-table-column prop="stat_date" :label="$t('date')" width="120"/>
              <el-table-column prop="total" :label="$t('total')" width="100"/>
              <el-table-column prop="errors" :label="$t('errors')" width="90"/>
              <el-table-column :label="$t('avgDuration')">
                <template #default="{row}">{{ row.avg_duration }} ms</template>
              </el-table-column>
              <el-table-column :label="$t('maxDuration')">
                <template #default="{row}">{{ row.max_duration }} ms</template>
              </el-table-column>
            </el-table>
          </div>

          <div class="stat-card">
            <div class="stat-title">{{ $t('topPaths') }}</div>
            <el-table :data="statPathRows" size="small" height="300">
              <el-table-column prop="path" :label="$t('path')" min-width="180" show-overflow-tooltip/>
              <el-table-column prop="total" :label="$t('total')" width="90"/>
              <el-table-column prop="errors" :label="$t('errors')" width="80"/>
              <el-table-column :label="$t('avgDuration')" width="110">
                <template #default="{row}">{{ row.avg_duration }} ms</template>
              </el-table-column>
            </el-table>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 明细详情 -->
    <el-drawer v-model="reqDetailShow" :title="$t('reqDetail')" size="620px">
      <div class="detail" v-if="reqDetail">
        <div class="row" v-for="item in reqDetailFields" :key="item.label">
          <div class="label">{{ item.label }}</div>
          <div class="value" :class="{mono: item.mono}">{{ item.value || '-' }}</div>
        </div>
      </div>
    </el-drawer>

    <!-- 审计详情 -->
    <el-drawer v-model="auditDetailShow" :title="$t('auditDetail')" size="620px">
      <div class="detail" v-if="auditDetail">
        <div class="row" v-for="item in auditDetailFields" :key="item.label">
          <div class="label">{{ item.label }}</div>
          <div class="value" :class="{mono: item.mono}">{{ item.value || '-' }}</div>
        </div>
      </div>
    </el-drawer>

    <!-- 日志配置 -->
    <el-dialog v-model="configShow" :title="$t('logConfig')" width="460">
      <div class="config-form" v-if="config">
        <div class="cfg-item">
          <span>{{ $t('logEnabled') }}</span>
          <el-switch v-model="config.logEnabled" :active-value="1" :inactive-value="0"/>
        </div>
        <div class="cfg-item">
          <span>{{ $t('logAuditEnabled') }}</span>
          <el-switch v-model="config.logAuditEnabled" :active-value="1" :inactive-value="0"/>
        </div>
        <div class="cfg-item">
          <span>{{ $t('logAuditDays') }}</span>
          <el-input-number v-model="config.logAuditDays" :min="0" :max="3650" size="small"/>
        </div>
        <div class="cfg-tip">{{ $t('logAuditDaysTip') }}</div>
        <div class="cfg-item">
          <span>{{ $t('logReqDays') }}</span>
          <el-input-number v-model="config.logReqDays" :min="0" :max="3650" size="small" disabled/>
        </div>
        <div class="cfg-tip">{{ $t('logReqDaysTip') }}</div>
        <div class="cfg-item">
          <span>{{ $t('logArchive') }}</span>
          <el-switch v-model="config.logArchive" :active-value="1" :inactive-value="0"/>
        </div>
      </div>
      <template #footer>
        <el-button size="small" @click="configShow = false">{{ $t('cancel') }}</el-button>
        <el-button size="small" type="primary" :loading="configSaving" @click="saveConfig">{{ $t('save') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import {computed, defineOptions, onBeforeUnmount, onMounted, reactive, ref, watch} from 'vue'
import {Icon} from '@iconify/vue'
import {useI18n} from 'vue-i18n'
import {
  auditLogDetail,
  auditLogExport,
  auditLogList,
  clearAuditLog,
  logConfig,
  logStatList,
  logStatPathList,
  reqLogList,
  reqLogOverview,
  setLogConfig
} from '@/request/log.js'

defineOptions({name: 'log'})

const {t} = useI18n()

const activeTab = ref('req')
const autoRefresh = ref(false)
let timer = null

const actionOptions = ['login', 'logout', 'register', 'reset-password', 'delete-account', 'send-email',
  'delete-email', 'add-account', 'remove-account', 'add-user', 'delete-user', 'set-user-password',
  'set-user-status', 'set-user-role', 'reset-send-count', 'add-role', 'set-role', 'delete-role',
  'set-setting', 'set-background', 'delete-background', 'add-reg-key', 'delete-reg-key', 'clear-reg-key',
  'delete-all-email', 'batch-delete-email', 'resend-webhook', 'oauth', 'public-api', 'clear-log',
  'set-log-config', 'error']

const moduleOptions = ['auth', 'email', 'account', 'user', 'role', 'setting', 'reg-key', 'all-email',
  'webhook', 'oauth', 'public', 'log', 'system']

function statusClass(status) {
  if (!status) return ''
  if (status >= 500) return 'st-5xx'
  if (status >= 400) return 'st-4xx'
  if (status >= 300) return 'st-3xx'
  return 'st-2xx'
}

/**
 * 统一把后端返回的 UTC 时间转成本地时间显示。
 * AE 明细返回 "YYYY-MM-DD HH:mm:ss"（UTC，无时区标记），
 * D1 审计返回 ISO 8601（"YYYY-MM-DDTHH:mm:ss.sssZ"）。
 * 旧实现只做字符串裁剪，导致东八区用户看到的时间比实际早 8 小时。
 */
function formatTime(v) {
  if (!v) return ''
  const s = String(v).trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return s
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
  if (isNaN(d.getTime())) return s
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 把日期选择器给出的本地时间字符串转成 UTC 字符串再传给后端。
 * 后端查询用的 AE timestamp / D1 created_at 都是 UTC，
 * 不转换会导致筛选结果整体偏移 8 小时。
 */
function localToUtc(localStr, withT = false) {
  if (!localStr) return ''
  const m = String(localStr).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return localStr
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
  if (isNaN(d.getTime())) return localStr
  const p = n => String(n).padStart(2, '0')
  const s = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  return withT ? s.replace(' ', 'T') : s
}

/* ==================== 请求明细 ==================== */

const reqLoading = ref(false)
const reqRows = ref([])
const reqOverview = ref(null)
const reqError = ref('')
const nextCursor = ref('')
const cursorStack = ref([])

const reqFilter = reactive({
  keyword: '',
  method: '',
  pathPrefix: '',
  onlyError: false,
  timeRange: []
})

function buildReqParams() {
  const p = {}
  if (reqFilter.keyword) p.keyword = reqFilter.keyword
  if (reqFilter.method) p.method = reqFilter.method
  if (reqFilter.pathPrefix) p.pathPrefix = reqFilter.pathPrefix
  if (reqFilter.onlyError) p.onlyError = '1'
  if (reqFilter.timeRange && reqFilter.timeRange.length === 2) {
    p.startTime = localToUtc(reqFilter.timeRange[0])
    p.endTime = localToUtc(reqFilter.timeRange[1])
  }
  p.pageSize = 50
  return p
}

async function loadReq(cursor = '') {
  reqLoading.value = true
  try {
    const params = buildReqParams()
    if (cursor) params.cursor = cursor

    const [list, overview] = await Promise.all([
      reqLogList(params),
      reqLogOverview(params)
    ])

    reqRows.value = list || []
    reqOverview.value = overview
    reqError.value = ''
    nextCursor.value = reqRows.value.length ? reqRows.value[reqRows.value.length - 1].time : ''
  } catch (e) {
    reqRows.value = []
    reqOverview.value = null
    nextCursor.value = ''
    // 旧实现只清空列表，用户无法区分「确实没有日志」和「查询报错」
    reqError.value = e?.message || t('reqFailErrorMsg')
  } finally {
    reqLoading.value = false
  }
}

function searchReq() {
  cursorStack.value = []
  loadReq('')
}

function resetReq() {
  reqFilter.keyword = ''
  reqFilter.method = ''
  reqFilter.pathPrefix = ''
  reqFilter.onlyError = false
  reqFilter.timeRange = []
  searchReq()
}

function reqNext() {
  if (!nextCursor.value) return
  cursorStack.value.push(nextCursor.value)
  loadReq(nextCursor.value)
}

function reqPrev() {
  cursorStack.value.pop()
  const cursor = cursorStack.value.length ? cursorStack.value[cursorStack.value.length - 1] : ''
  loadReq(cursor)
}

/* 明细详情 */
const reqDetailShow = ref(false)
const reqDetail = ref(null)

const reqDetailFields = computed(() => {
  const d = reqDetail.value || {}
  return [
    {label: t('time'), value: formatTime(d.time)},
    {label: t('method'), value: d.method},
    {label: t('path'), value: d.path, mono: true},
    {label: t('status'), value: d.status},
    {label: t('duration'), value: d.duration ? Math.round(d.duration) + ' ms' : ''},
    {label: t('user'), value: d.user_email},
    {label: 'User ID', value: d.user_id},
    {label: 'IP', value: d.ip},
    {label: t('region'), value: [d.country, d.colo].filter(Boolean).join(' / ')},
    {label: 'Ray ID', value: d.ray_id, mono: true},
    {label: t('action'), value: d.action},
    {label: t('module'), value: d.module},
    {label: 'User-Agent', value: d.ua, mono: true},
    {label: t('requestBody'), value: d.body, mono: true},
    {label: t('errorStack'), value: d.error, mono: true}
  ]
})

function openReqDetail(row) {
  reqDetail.value = row
  reqDetailShow.value = true
}

/* ==================== 审计日志 ==================== */

const auditLoading = ref(false)
const auditRows = ref([])
const auditTotal = ref(0)
const auditError = ref('')

const auditFilter = reactive({
  keyword: '',
  action: '',
  module: '',
  timeRange: [],
  pageNum: 1,
  pageSize: 20
})

function buildAuditParams() {
  const p = {
    pageNum: auditFilter.pageNum,
    pageSize: auditFilter.pageSize
  }
  if (auditFilter.keyword) p.keyword = auditFilter.keyword
  if (auditFilter.action) p.action = auditFilter.action
  if (auditFilter.module) p.module = auditFilter.module
  if (auditFilter.timeRange && auditFilter.timeRange.length === 2) {
    p.startTime = localToUtc(auditFilter.timeRange[0], true)
    p.endTime = localToUtc(auditFilter.timeRange[1], true)
  }
  return p
}

async function loadAudit() {
  auditLoading.value = true
  try {
    const res = await auditLogList(buildAuditParams())
    auditRows.value = res?.list || []
    auditTotal.value = res?.total || 0
    auditError.value = ''
  } catch (e) {
    auditRows.value = []
    auditTotal.value = 0
    auditError.value = e?.message || t('reqFailErrorMsg')
  } finally {
    auditLoading.value = false
  }
}

function searchAudit() {
  auditFilter.pageNum = 1
  loadAudit()
}

function resetAudit() {
  auditFilter.keyword = ''
  auditFilter.action = ''
  auditFilter.module = ''
  auditFilter.timeRange = []
  auditFilter.pageNum = 1
  loadAudit()
}

const auditDetailShow = ref(false)
const auditDetail = ref(null)

const auditDetailFields = computed(() => {
  const d = auditDetail.value || {}
  return [
    {label: 'ID', value: d.log_id},
    {label: t('time'), value: formatTime(d.created_at)},
    {label: t('user'), value: d.user_email},
    {label: 'User ID', value: d.user_id},
    {label: t('action'), value: d.action},
    {label: t('module'), value: d.module},
    {label: t('method'), value: d.method},
    {label: t('path'), value: d.path, mono: true},
    {label: t('status'), value: d.status},
    {label: t('duration'), value: d.duration ? d.duration + ' ms' : ''},
    {label: 'IP', value: d.ip},
    {label: t('region'), value: d.country},
    {label: 'Ray ID', value: d.ray_id, mono: true},
    {label: t('target'), value: d.target},
    {label: 'User-Agent', value: d.ua, mono: true},
    {label: t('requestBody'), value: d.detail, mono: true},
    {label: t('errorStack'), value: d.error, mono: true}
  ]
})

async function openAuditDetail(row) {
  try {
    const data = await auditLogDetail(row.log_id)
    auditDetail.value = data || row
  } catch (e) {
    auditDetail.value = row
  }
  auditDetailShow.value = true
}

async function exportAudit() {
  try {
    const params = buildAuditParams()
    delete params.pageNum
    delete params.pageSize
    const blob = await auditLogExport(params)
    const url = URL.createObjectURL(new Blob([blob], {type: 'text/csv;charset=utf-8'}))
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-log-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage({message: t('exportSuccessMsg'), type: 'success', plain: true})
  } catch (e) {
    ElMessage({message: t('exportFailMsg'), type: 'error', plain: true})
  }
}

function clearAudit() {
  ElMessageBox.prompt(t('clearLogConfirm'), t('clearLog'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    inputPlaceholder: t('clearLogPlaceholder'),
    inputPattern: /^\d*$/,
    inputErrorMessage: t('clearLogInputError')
  }).then(async ({value}) => {
    const params = {}
    if (value) {
      params.beforeDays = Number(value)
    }
    const res = await clearAuditLog(params)
    ElMessage({
      message: t('clearSuccessMsg').replace('{n}', res?.changes === -1 ? '∞' : (res?.changes ?? 0)),
      type: 'success',
      plain: true
    })
    loadAudit()
  }).catch(() => {
  })
}

/* ==================== 统计 ==================== */

const statDays = ref(30)
const statRows = ref([])
const statPathRows = ref([])
const statError = ref('')

async function loadStat() {
  try {
    const [rows, paths] = await Promise.all([
      logStatList({days: statDays.value}),
      logStatPathList({days: statDays.value})
    ])
    statRows.value = rows || []
    statPathRows.value = paths || []
    statError.value = ''
  } catch (e) {
    statRows.value = []
    statPathRows.value = []
    statError.value = e?.message || t('reqFailErrorMsg')
  }
}

/* ==================== 配置 ==================== */

const configShow = ref(false)
const config = ref(null)
const configSaving = ref(false)

async function openConfig() {
  try {
    config.value = await logConfig()
    configShow.value = true
  } catch (e) {
    configShow.value = false
  }
}

async function saveConfig() {
  configSaving.value = true
  try {
    config.value = await setLogConfig(config.value)
    ElMessage({message: t('saveSuccessMsg'), type: 'success', plain: true})
    configShow.value = false
  } finally {
    configSaving.value = false
  }
}

/* ==================== 通用 ==================== */

function refreshAll() {
  if (activeTab.value === 'req') {
    loadReq('')
  } else if (activeTab.value === 'audit') {
    loadAudit()
  } else {
    loadStat()
  }
}

function startTimer() {
  stopTimer()
  // 30s 一次：每次刷新会发 2 个 AE 查询，10s 的频率在 Workers Free 计划下
  // （AE 读查询 10000 次/天）约 14 小时就会耗尽免费额度。
  timer = setInterval(() => {
    if (document.hidden) return
    refreshAll()
  }, 30000)
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

onMounted(() => {
  loadReq('')
  loadAudit()
  loadStat()
})

onBeforeUnmount(() => {
  stopTimer()
})

// 自动刷新开关
watch(autoRefresh, (v) => {
  v ? startTimer() : stopTimer()
})

watch(activeTab, () => {
  refreshAll()
})
</script>

<style scoped lang="scss">
.log-page {
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;

  @media (max-width: 767px) {
    padding: 14px;
  }
}

.log-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--el-color-error-light-9);
  color: var(--el-color-error);
  font-size: 13px;
  line-height: 1.5;
  word-break: break-all;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;

  .title {
    font-size: 18px;
    font-weight: bold;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 10px;

    .auto-refresh {
      display: flex;
      align-items: center;      gap: 6px;
      font-size: 13px;
      color: var(--regular-text-color);
    }
  }
}

.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.w100 { width: 100px; }
.w130 { width: 130px; }
.w150 { width: 150px; }
.w200 { width: 200px; }
.w330 { width: 330px; }

.overview {
  display: flex;
  gap: 20px;
  font-size: 13px;
  margin-bottom: 10px;
  color: var(--regular-text-color);

  b { color: var(--primary-text-color); }
  .err { color: #e6a23c; }
}

.log-table {
  width: 100%;
  cursor: pointer;

  :deep(.el-table__row:hover) {
    cursor: pointer;
  }
}

.st-2xx { color: #67c23a; }
.st-3xx { color: #909399; }
.st-4xx { color: #e6a23c; }
.st-5xx { color: #f56c6c; font-weight: bold; }

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 12px;

  .page-info {
    font-size: 12px;
    color: var(--regular-text-color);
  }
}

.stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;

  @media (max-width: 900px) {
    grid-template-columns: 1fr;
  }

  .stat-card {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px;

    .stat-title {
      font-size: 14px;
      font-weight: bold;
      margin-bottom: 8px;
    }
  }
}

.tip {
  font-size: 12px;
  color: var(--regular-text-color);
}

.detail {
  font-size: 13px;

  .row {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-color);

    .label {
      color: var(--regular-text-color);
    }

    .value {
      word-break: break-all;
      white-space: pre-wrap;

      &.mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
      }
    }
  }
}

.config-form {
  display: flex;
  flex-direction: column;
  gap: 12px;

  .cfg-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 14px;
  }

  .cfg-tip {
    font-size: 12px;
    color: var(--regular-text-color);
    margin-top: -8px;
    line-height: 1.5;
  }
}
</style>
