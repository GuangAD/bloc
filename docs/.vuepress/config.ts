import { defineUserConfig } from '@vuepress/cli'
import { defaultTheme } from '@vuepress/theme-default'
import {navbar, sidebar} from '../pages/index'
import { searchPlugin } from'@vuepress/plugin-search'

console.log(sidebar);

export default defineUserConfig({
  lang: 'zh-CN',
  title: '你好， VuePress ！',
  description: '这是我的第一个 VuePress 站点',
  theme: defaultTheme({
    sidebarDepth: 0,
    logo: 'https://vuejs.org/images/logo.png',
    navbar: navbar,
    sidebar: sidebar
  }),
  plugins: [
    searchPlugin({
      // 配置项
    }),
  ]
})