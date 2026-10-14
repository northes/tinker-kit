export type NameTransform = {
  mode: 'prefix' | 'suffix' | 'replace' | 'custom';
  value: string;
  find: string;
  replacement: string;
};

// 只处理字符串变换；文件扩展名、镜像仓库与目标冲突仍由业务方校验。
export function transformName(name: string, form: NameTransform) {
  switch (form.mode) {
    case 'prefix':
      return `${form.value}${name}`;
    case 'suffix':
      return `${name}${form.value}`;
    case 'replace':
      return form.find ? name.split(form.find).join(form.replacement) : name;
    case 'custom':
      return form.value;
  }
}
