declare module "*.sql?raw" {
  const value: string;
  export default value;
}

declare module "*.md?raw" {
  const value: string;
  export default value;
}

interface ImportMeta {
  glob<T>(
    pattern: string,
    options: {
      eager: true;
      import: "default";
      query: "?raw";
    },
  ): Record<string, T>;
}
