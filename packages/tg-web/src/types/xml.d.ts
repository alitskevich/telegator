/** esbuild loads every `.xml` as text (`scripts/web.ts`); a CML template is a string. */
declare module "*.xml" {
  const template: string;
  export default template;
}
