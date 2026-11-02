import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './styles/global.less'
import 'tdesign-vue-next/es/style/index.css'
import App from './App.vue'
import router from './router'
import { installUIControl, startUICommandBridge } from './modules/ui-control'

const app = createApp(App)

app.use(createPinia())
app.use(router)

// UI Control：让平台助理可以跳转页面 / 打开弹窗（语义化操作，不操作 DOM）
installUIControl(router)

// 指令通道：桌宠发起界面操作时，由网页版代为执行（长轮询，有指令立刻返回）
startUICommandBridge()

app.mount('#app')
