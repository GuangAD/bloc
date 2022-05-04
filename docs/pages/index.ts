import { scanDir } from "../utils/index";
import { resolve } from "path";
import {
  SidebarConfig,
  SidebarConfigArray,
  SidebarConfigObject,
} from "vuepress";
const pages = ["vue", "flutter", "react"];

function generateSldebar(path: string): SidebarConfigArray {
  return [
    {
      text: path,
      link: `/${path}`,
      collapsible: false,
      children: scanDir(resolve(__dirname, `../${path}`)).map(
        (element) => ({
          text: `${element}`,
          link: `/${path}/${element}`
        })
      ),
    },
  ];
}

function strMapToObj(strMap: Map<string, any>) {
  let obj = Object.create(null);
  for (let [k, v] of strMap) {
    obj[k] = v;
  }
  return obj;
}

const navbar = pages.map((element) => ({
  text: element,
  link: `/${element}`,
}));

const sidebar: SidebarConfig = strMapToObj(
  new Map(pages.map((element) => [`/${element}`, generateSldebar(element)]))
);

export { navbar, sidebar };
