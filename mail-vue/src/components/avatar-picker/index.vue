<template>
  <div class="avatar-picker">
    <div class="preview">
      <img v-if="previewUrl" :src="previewUrl" alt="avatar"/>
      <span v-else>{{ fallbackText }}</span>
    </div>
    <div class="ops">
      <div class="tip">{{ $t('avatarFormatTip') }}</div>
      <div class="tip">{{ $t('avatarSizeTip') }}</div>
      <div class="btns">
        <el-button type="primary" :loading="uploading" @click="chooseFile">
          {{ previewUrl ? $t('changeAvatar') : $t('setAvatar') }}
        </el-button>
        <el-button v-if="previewUrl" :disabled="uploading" @click="doRemove">{{ $t('removeAvatar') }}</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import {computed, defineOptions, ref} from 'vue'
import axios from 'axios'
import {avatarPresign, saveAvatar, removeAvatar} from '@/request/my.js'
import {userSetAvatar, userRemoveAvatar} from '@/request/user.js'
import {useI18n} from 'vue-i18n'

defineOptions({
  name: 'avatar-picker'
})

const props = defineProps({
  // 当前头像地址（可空）
  modelValue: {
    type: String,
    default: ''
  },
  // self：改自己的头像；admin：管理员为 userId 指定的用户设置头像
  mode: {
    type: String,
    default: 'self'
  },
  userId: {
    type: Number,
    default: 0
  },
  // 未设置头像时显示的兜底文字（一般为邮箱首字母）
  fallbackText: {
    type: String,
    default: '?'
  }
})

const emit = defineEmits(['update:modelValue', 'success'])

const { t } = useI18n()

// 与后端白名单保持一致（后端以扩展名为准，这里先挡一道，避免白传）
const ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

// 前端仅提示、不做硬性限制；与后端防滥用上限保持一致，避免传完才失败
const SOFT_LIMIT = 5 * 1024 * 1024
const HARD_LIMIT = 20 * 1024 * 1024

const uploading = ref(false)
const localPreview = ref('')

const previewUrl = computed(() => localPreview.value || props.modelValue || '')

function extOf(filename) {
  const index = filename.lastIndexOf('.')
  return index === -1 ? '' : filename.slice(index).toLowerCase()
}

function chooseFile() {

  const doc = document.createElement('input')
  doc.setAttribute('type', 'file')
  doc.setAttribute('accept', 'image/png,image/jpeg,image/webp,image/gif')
  doc.onchange = () => {
    const file = doc.files && doc.files[0]
    if (file) {
      doUpload(file)
    }
  }
  doc.click()
}

async function doUpload(file) {

  if (!ALLOWED_EXT.includes(extOf(file.name))) {
    ElMessage({
      message: t('avatarFormatInvalid'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (file.size > HARD_LIMIT) {
    ElMessage({
      message: t('avatarTooLarge'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (file.size > SOFT_LIMIT) {
    ElMessage({
      message: t('avatarLargeTip'),
      type: 'warning',
      plain: true,
    })
  }

  // 本地先预览，上传完成后由父组件用服务端地址替换
  if (localPreview.value) {
    URL.revokeObjectURL(localPreview.value)
  }
  localPreview.value = URL.createObjectURL(file)

  uploading.value = true

  let res

  try {
    res = await avatarPresign({
      filename: file.name,
      size: file.size,
      contentType: file.type
    })
  } catch (e) {
    // 业务错误已由 axios 拦截器提示
    uploading.value = false
    return
  }

  try {
    // 用原生 axios 直传，避免带上本站 Authorization 头影响预签名校验
    await axios.put(res.uploadUrl, file, {headers: res.headers})
  } catch (e) {
    uploading.value = false
    ElMessage({
      message: t('avatarUploadFail'),
      type: 'error',
      plain: true,
    })
    return
  }

  try {
    if (props.mode === 'admin') {
      await userSetAvatar({userId: props.userId, key: res.key})
    } else {
      await saveAvatar(res.key)
    }
  } catch (e) {
    uploading.value = false
    return
  }

  uploading.value = false

  emit('update:modelValue', res.key)
  emit('success', res.key)

  ElMessage({
    message: t('avatarSaveSuccess'),
    type: 'success',
    plain: true,
  })
}

function doRemove() {

  ElMessageBox.confirm(t('avatarRemoveConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(async () => {

    if (props.mode === 'admin') {
      await userRemoveAvatar(props.userId)
    } else {
      await removeAvatar()
    }

    if (localPreview.value) {
      URL.revokeObjectURL(localPreview.value)
      localPreview.value = ''
    }

    emit('update:modelValue', '')
    emit('success', '')

    ElMessage({
      message: t('avatarRemoveSuccess'),
      type: 'success',
      plain: true,
    })
  }).catch(() => { /* 取消 */ })
}
</script>

<style scoped lang="scss">
.avatar-picker {
  display: flex;
  gap: 20px;
  align-items: flex-start;

  .preview {
    flex: none;
    width: 72px;
    height: 72px;
    border-radius: 12px;
    border: 1px solid var(--dark-border, var(--el-border-color));
    background: var(--el-bg-color);
    color: var(--el-text-color-primary);
    font-size: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
  }

  .ops {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;

    .tip {
      font-size: 12px;
      color: var(--regular-text-color);
      line-height: 1.5;
    }

    .btns {
      margin-top: 6px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
  }

  @media (max-width: 767px) {
    flex-direction: column;
    align-items: center;

    .ops {
      align-items: center;
      text-align: center;
    }
  }
}
</style>
