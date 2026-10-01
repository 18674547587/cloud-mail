<template>
  <emailScroll ref="scroll"
               :cancel-success="cancelStar"
               :star-success="addStar"
               :getEmailList="getEmailList"
               :emailDelete="emailDelete"
               :star-add="starAdd"
               :star-cancel="starCancel"
               :time-sort="params.timeSort"
               :email-read="emailRead"
               :show-unread="true"
               actionLeft="4px"
               @jump="jumpContent"
  >
    <template #first>
      <Icon class="icon" @click="changeTimeSort" icon="material-symbols-light:timer-arrow-down-outline"
            v-if="params.timeSort === 0" width="28" height="28"/>
      <Icon class="icon" @click="changeTimeSort" icon="material-symbols-light:timer-arrow-up-outline" v-else
            width="28" height="28"/>
    </template>

  </emailScroll>
</template>

<script setup>
import {useAccountStore} from "@/store/account.js";
import {useEmailStore} from "@/store/email.js";
import {useSettingStore} from "@/store/setting.js";
import emailScroll from "@/components/email-scroll/index.vue"
import {emailList, emailDelete, emailLatest, emailRead} from "@/request/email.js";
import {starAdd, starCancel} from "@/request/star.js";
import {defineOptions, h, onMounted, onUnmounted, reactive, ref, watch} from "vue";
import {sleep} from "@/utils/time-utils.js";
import {connect as connectPush, disconnect as disconnectPush, onNewEmail} from "@/utils/push-client.js";
import router from "@/router/index.js";
import {Icon} from "@iconify/vue";
import { useRoute } from 'vue-router'

defineOptions({
  name: 'email'
})

const route = useRoute();
const emailStore = useEmailStore();
const accountStore = useAccountStore();
const settingStore = useSettingStore();
const scroll = ref({})
const params = reactive({
  timeSort: 0,
})

let cancelPushListener = null;

onMounted(() => {
  emailStore.emailScroll = scroll;
  latest()

  // 实时推送：收到"有新邮件"信号后立即拉取一次
  // 不依赖"自动刷新"设置——即使轮询被关闭，推送依然生效
  cancelPushListener = onNewEmail(() => {
    pullLatest();
  });
  connectPush();
})

onUnmounted(() => {
  if (cancelPushListener) cancelPushListener();
  disconnectPush();
})


watch(() => accountStore.currentAccountId, () => {
  scroll.value.refreshList();
})

function changeTimeSort() {
  params.timeSort = params.timeSort ? 0 : 1
  scroll.value.refreshList();
}

function jumpContent(email) {
  emailStore.contentData.email = email
  emailStore.contentData.delType = 'logic'
  emailStore.contentData.showUnread = true
  emailStore.contentData.showStar = true
  emailStore.contentData.showReply = true
  router.push('/message')
}

const existIds = new Set();

async function latest() {
  while (true) {

    let autoRefresh = settingStore.settings.autoRefresh;
    await sleep(autoRefresh > 1 ? autoRefresh * 1000 : 3000);

    if (route.name !== 'email') {
      continue;
    }

    // 自动刷新开启时才轮询；关闭时仅由实时推送触发拉取
    if (autoRefresh > 1) {
      await pullLatest();
    }
  }
}

// 防止轮询与实时推送同时触发造成重复请求
let pulling = false;
let pullAgain = false;

/**
 * 立即拉取一次新邮件
 * 触发来源：1) 定时轮询  2) 实时推送收到"有新邮件"信号
 */
async function pullLatest() {

  if (pulling) {
    // 已有请求在途：标记稍后再拉一次，避免漏掉刚到达的邮件
    pullAgain = true;
    return;
  }

  pulling = true;

  try {

    if (route.name !== 'email') return;
    if (scroll.value.firstLoad) return;

    const latestId = scroll.value.latestEmail?.emailId

    const accountId = accountStore.currentAccountId
    const allReceive = scroll.value.latestEmail?.allReceive
    const curTimeSort = params.timeSort
    let list = []

    //确保发起请求时最后一个邮件是当前账号的,或者
    if (accountId === scroll.value.latestEmail?.reqAccountId) {
      list = await emailLatest(latestId, accountId, allReceive);
    }

    //确保请求回来后，账号没有切换，时间排序没有改变，全部邮件类型没变
    if (accountId === accountStore.currentAccountId && params.timeSort === curTimeSort && allReceive === accountStore.currentAccount.allReceive) {
      if (list.length > 0) {

        for (let email of list) {

          email.reqAccountId = accountId;
          email.allReceive = allReceive;

          if (!existIds.has(email.emailId)) {

            existIds.add(email.emailId)
            scroll.value.addItem(email)

            await sleep(50)
          }

        }

      }

    }

  } catch (e) {
    if (e.code === 401 || e.code === 403) {
      settingStore.settings.autoRefresh = 0;
    }
    console.error(e)
  } finally {
    pulling = false;
    if (pullAgain) {
      pullAgain = false;
      pullLatest();
    }
  }
}

function addStar(email) {
  emailStore.starScroll?.addItem(email)
}

function cancelStar(email) {
  emailStore.starScroll?.deleteEmail([email.emailId])
}

function getEmailList(emailId, size) {
  const accountId =  accountStore.currentAccountId;
  const allReceive = accountStore.currentAccount.allReceive;
  return emailList(accountId, allReceive, emailId, params.timeSort, size, 0).then(data => {
    data.latestEmail.reqAccountId = accountId;
    data.latestEmail.allReceive = allReceive;
    return data;
  })
}

</script>
<style>
.icon {
  cursor: pointer;
}
</style>
