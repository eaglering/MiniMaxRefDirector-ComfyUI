import { createRouter, createWebHashHistory } from "vue-router";

const routes = [
  { path: "/", redirect: "/storyboard" },
  { path: "/global", name: "global", component: () => import("../views/GlobalParams.vue"), meta: { title: "全局参数" } },
  { path: "/subjects", name: "subjects", component: () => import("../views/Subjects.vue"), meta: { title: "主体管理" } },
  { path: "/storyboard", name: "storyboard", component: () => import("../views/Storyboard.vue"), meta: { title: "分镜" } },
  { path: "/records", name: "records", component: () => import("../views/Records.vue"), meta: { title: "生成记录" } },
];

export default createRouter({
  history: createWebHashHistory(),
  routes,
});
