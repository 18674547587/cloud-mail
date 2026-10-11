<template>
  <div class="box">
    <div class="container">
      <div class="title">{{$t('profile')}}</div>
      <div class="item">
        <div>{{$t('avatar')}}</div>
        <div class="avatar-item">
          <div class="avatar-thumb">
            <img v-if="userStore.user.avatarUrl" :src="userStore.user.avatarUrl" alt="avatar"/>
            <span v-else>{{ formatName(userStore.user.email) }}</span>
          </div>
          <el-button type="primary" @click="avatarShow = true">{{$t('changeAvatar')}}</el-button>
        </div>
      </div>
      <div class="item">
        <div>{{$t('username')}}</div>
        <div>
          <span v-if="setNameShow" class="edit-name-input">
            <el-input v-model="accountName"  ></el-input>
            <span class="edit-name" @click="setName">
             {{$t('save')}}
            </span>
          </span>
          <span v-else class="user-name">
            <span >{{ userStore.user.name }}</span>
            <span class="edit-name" @click="showSetName">
             {{$t('change')}}
            </span>
          </span>
        </div>
      </div>
      <div class="item">
        <div>{{$t('emailAccount')}}</div>
        <div>{{ userStore.user.email }}</div>
      </div>
      <div class="item">
        <div>{{$t('password')}}</div>
        <div>
          <el-button type="primary" @click="pwdShow = true">{{$t('changePwdBtn')}}</el-button>
        </div>
      </div>
      <div class="item">
        <div>{{$t('captchaProviderSetting')}}</div>
        <div>
          <el-select v-model="captchaProvider" style="width: 190px" @change="onCaptchaProviderChange" placeholder="Select">
            <el-option :value="0" :label="$t('captchaProviderFollowDefault')"/>
            <el-option :value="1" :label="$t('captchaProviderTurnstile')"/>
            <el-option :value="2" :label="$t('captchaProviderHcaptcha')"/>
          </el-select>
        </div>
      </div>
    </div>
    <div class="del-email" v-perm="'my:delete'">
      <div class="title">{{$t('deleteUser')}}</div>
      <div style="color: var(--regular-text-color);">
        {{$t('delAccountMsg')}}
      </div>
      <div>
        <el-button type="primary" @click="deleteConfirm">{{$t('deleteUserBtn')}}</el-button>
      </div>
    </div>
    <div class="device-mgr">
      <div class="title">{{$t('deviceManage')}}</div>
      <div class="device-tip">{{$t('deviceManageTip')}}</div>
      <div class="device-actions">
        <el-button type="primary" @click="showCreate = true">{{$t('createDeviceToken')}}</el-button>
        <el-button :loading="deviceLoading" @click="loadDevices">{{$t('refresh')}}</el-button>
      </div>
      <div class="device-table">
        <el-table :data="devices" v-loading="deviceLoading" style="width: 100%">
          <template #empty>
            <span style="color: var(--regular-text-color);">{{$t('deviceEmpty')}}</span>
          </template>
          <el-table-column prop="name" :label="$t('deviceName')" min-width="120" show-overflow-tooltip/>
          <el-table-column :label="$t('createTime')" min-width="150">
            <template #default="{ row }">{{ fmtTime(row.createTime) }}</template>
          </el-table-column>
          <el-table-column :label="$t('lastUsedTime')" min-width="150">
            <template #default="{ row }">
              {{ row.lastUsedTime ? fmtTime(row.lastUsedTime) : $t('neverUsed') }}
            </template>
          </el-table-column>
          <el-table-column :label="$t('operate')" width="90" align="right">
            <template #default="{ row }">
              <el-button link type="danger" @click="revokeDevice(row)">{{$t('revoke')}}</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div class="device-cards" v-loading="deviceLoading">
        <div class="device-card" v-for="item in devices" :key="item.tokenId">
          <div class="card-head">
            <span class="card-name">{{ item.name }}</span>
            <el-button link type="danger" @click="revokeDevice(item)">{{$t('revoke')}}</el-button>
          </div>
          <div class="card-meta">
            <span>{{$t('createTime')}}：{{ fmtTime(item.createTime) }}</span>
            <span>{{$t('lastUsedTime')}}：{{ item.lastUsedTime ? fmtTime(item.lastUsedTime) : $t('neverUsed') }}</span>
          </div>
        </div>
        <div class="device-empty" v-if="!deviceLoading && !devices.length">{{$t('deviceEmpty')}}</div>
      </div>
    </div>
    <el-dialog v-model="showCreate" :title="$t('createDeviceToken')" width="min(400px, calc(100vw - 40px))">
      <el-input v-model="newDeviceName" :placeholder="$t('deviceNamePlaceholder')" maxlength="40"
                show-word-limit @keyup.enter="doCreateDevice"/>
      <template #footer>
        <el-button @click="showCreate = false">{{$t('cancel')}}</el-button>
        <el-button type="primary" :loading="creating" @click="doCreateDevice">{{$t('confirm')}}</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="showToken" :title="$t('tokenCreatedTitle')" width="min(520px, calc(100vw - 40px))">
      <div class="token-once-tip">{{$t('tokenOnceTip')}}</div>
      <div class="token-row">
        <el-input v-model="createdToken" readonly/>
        <el-button type="primary" @click="copyToken">{{$t('copy')}}</el-button>
      </div>
    </el-dialog>
    <el-dialog v-model="avatarShow" :title="$t('setAvatar')" width="min(440px, calc(100vw - 40px))">
      <avatar-picker
          :model-value="userStore.user.avatarUrl"
          :fallback-text="formatName(userStore.user.email)"
          @success="onAvatarSuccess"/>
    </el-dialog>
    <el-dialog v-model="pwdShow" :title="$t('changePassword')" width="340">
      <div class="update-pwd">
        <el-input type="password" :placeholder="$t('newPassword')" v-model="form.password" autocomplete="off"/>
        <el-input type="password" :placeholder="$t('confirmPassword')" v-model="form.newPwd" autocomplete="off"/>
        <el-button type="primary" :loading="setPwdLoading" @click="submitPwd">{{$t('save')}}</el-button>
      </div>
    </el-dialog>
  </div>
</template>
<script setup>
import {reactive, ref, defineOptions, onMounted} from 'vue'
import {resetPassword, userDelete, captchaConfig, saveCaptchaProvider as saveCaptchaProviderApi} from "@/request/my.js";
import {createAppToken, listAppToken, revokeAppToken} from "@/request/app.js";
import {copyText} from "@/utils/clipboard-utils.js";
import {useUserStore} from "@/store/user.js";
import router from "@/router/index.js";
import {accountSetName} from "@/request/account.js";
import {useAccountStore} from "@/store/account.js";
import {useI18n} from "vue-i18n";
import dayjs from 'dayjs';
import avatarPicker from '@/components/avatar-picker/index.vue'
import {formatName} from '@/utils/text.js';

const { t } = useI18n()
const accountStore = useAccountStore()
const userStore = useUserStore();
const setPwdLoading = ref(false)
const setNameShow = ref(false)
const accountName = ref(null)

// ===================== 头像 =====================

const avatarShow = ref(false)

function onAvatarSuccess() {
  // 重新拉取用户信息，让右上角头像与个人资料页保持一致
  userStore.refreshUserInfo()
}

// ===================== 人机验证偏好 =====================

const captchaProvider = ref(0)

async function loadCaptchaPreference() {
  try {
    const data = await captchaConfig()
    captchaProvider.value = data.userProvider || 0
  } catch (e) {
    console.warn('读取人机验证偏好失败', e)
  }
}

function onCaptchaProviderChange(value) {
  saveCaptchaProviderApi(value).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true
    })
  }).catch(() => {
    loadCaptchaPreference()
  })
}

defineOptions({
  name: 'setting'
})

function showSetName() {
  accountName.value = userStore.user.name
  setNameShow.value = true
}

function setName() {

  if (!accountName.value) {
    ElMessage({
      message: t('emptyUserNameMsg'),
      type: 'error',
      plain: true,
    })
    return;
  }

  setNameShow.value = false
  let name = accountName.value

  if (name === userStore.user.name) {
    return
  }

  userStore.user.name = accountName.value

  accountSetName(userStore.user.account.accountId,name).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })

    accountStore.changeUserAccountName = name

  }).catch(() => {
    userStore.user.name = name
  })
}

const pwdShow = ref(false)
const form = reactive({
  password: '',
  newPwd: '',
})

const deleteConfirm = () => {
  ElMessageBox.confirm(t('delAccountConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    userDelete().then(() => {
      localStorage.removeItem('token');
      router.replace('/login');
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true,
      })
    })
  })
}


function submitPwd() {

  if (!form.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password.length < 6) {
    ElMessage({
      message: t('pwdLengthMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password !== form.newPwd) {
    ElMessage({
      message: t('confirmPwdFailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  setPwdLoading.value = true
  resetPassword(form.password).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
    pwdShow.value = false
    setPwdLoading.value = false
    form.password = ''
    form.newPwd = ''
  }).catch(() => {
    setPwdLoading.value = false
  })

}

// ===================== 设备令牌管理 =====================

const devices = ref([])
const deviceLoading = ref(false)
const showCreate = ref(false)
const creating = ref(false)
const newDeviceName = ref('')
const showToken = ref(false)
const createdToken = ref('')

function fmtTime(t) {
  if (!t) {
    return ''
  }
  return dayjs(t).format('YYYY-MM-DD HH:mm')
}

function loadDevices() {
  deviceLoading.value = true
  listAppToken().then((list) => {
    devices.value = list || []
  }).finally(() => {
    deviceLoading.value = false
  })
}

function doCreateDevice() {
  creating.value = true
  createAppToken(newDeviceName.value || undefined).then((data) => {
    createdToken.value = data.token
    showToken.value = true
    showCreate.value = false
    newDeviceName.value = ''
    loadDevices()
  }).finally(() => {
    creating.value = false
  })
}

function copyToken() {
  copyText(createdToken.value).then((ok) => {
    ElMessage({
      message: ok ? t('copySuccessMsg') : t('copyFailMsg'),
      type: ok ? 'success' : 'error',
      plain: true,
    })
  })
}

function revokeDevice(row) {
  ElMessageBox.confirm(t('revokeConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    revokeAppToken(row.tokenId).then(() => {
      ElMessage({
        message: t('revokeSuccessMsg'),
        type: 'success',
        plain: true,
      })
      loadDevices()
    })
  })
}

onMounted(() => {
  loadDevices()
  loadCaptchaPreference()
})

</script>
<style scoped lang="scss">
.box {
  padding: 40px 40px;

  @media (max-width: 767px) {
    padding: 30px 30px;
  }

  .update-pwd {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }

  .title {
    font-size: 18px;
    font-weight: bold;
  }

  .container {
    font-size: 14px;
    display: grid;
    gap: 20px;
    margin-bottom: 40px;

    .item {
      display: grid;
      grid-template-columns: 50px 1fr;
      gap: 140px;
      position: relative;
      .user-name {
        display: grid;
        grid-template-columns: auto 1fr;
        span:first-child {
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
      }

      .avatar-item {
        display: flex;
        align-items: center;
        gap: 15px;

        .avatar-thumb {
          flex: none;
          width: 40px;
          height: 40px;
          border-radius: 10px;
          overflow: hidden;
          border: 1px solid var(--dark-border, var(--el-border-color));
          background: var(--el-bg-color);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;

          img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
          }
        }
      }

      .edit-name-input {
        position: absolute;
        bottom: -6px;
        .el-input {
          width: min(200px,calc(100vw - 222px));
        }
      }

      .edit-name {
        color: #4dabff;
        padding-left: 10px;
        cursor: pointer;
      }

      @media (max-width: 767px) {
        gap: 70px;
      }

      div:first-child {
        font-weight: bold;
      }

      div:last-child {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
    }
  }

  .del-email {
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-bottom: 40px;
  }

  .device-mgr {
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 15px;
    margin-bottom: 40px;

    .device-tip {
      color: var(--regular-text-color);
      font-size: 13px;
      line-height: 1.6;
    }

    .device-actions {
      display: flex;
      gap: 10px;
    }

    // 桌面端：表格
    .device-table {
      display: block;
    }

    // 移动端：卡片列表（表格在窄屏必然横向溢出，故整块切换）
    .device-cards {
      display: none;
      flex-direction: column;
      gap: 10px;
      min-height: 40px;

      .device-card {
        border: 1px solid var(--el-border-color-lighter);
        border-radius: 8px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;

        .card-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;

          .card-name {
            font-weight: bold;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
          }
        }

        .card-meta {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 12px;
          color: var(--regular-text-color);
        }
      }

      .device-empty {
        text-align: center;
        padding: 20px 0;
        color: var(--regular-text-color);
      }
    }

    @media (max-width: 767px) {
      .device-table {
        display: none;
      }

      .device-cards {
        display: flex;
      }
    }
  }

  .token-once-tip {
    color: #e6a23c;
    font-size: 13px;
    margin-bottom: 12px;
  }

  .token-row {
    display: flex;
    gap: 10px;

    .el-input {
      flex: 1;
      min-width: 0;
    }
  }
}
</style>
