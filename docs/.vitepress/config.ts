import { defineConfig } from "vitepress";

export default defineConfig({
  title: "TrajRx",
  description: "IDE agent trajectory analysis and efficiency attribution pipeline",
  base: "/",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Architecture", link: "/architecture/overview" },
      { text: "Reference", link: "/reference/invariants" },
      { text: "GitHub", link: "https://github.com" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "CLI Usage", link: "/guide/cli" },
            { text: "Environment", link: "/guide/environment" },
            { text: "Codex vs Cursor", link: "/guide/sources" },
          ],
        },
      ],
      "/architecture/": [
        {
          text: "Architecture",
          items: [
            { text: "Overview", link: "/architecture/overview" },
            { text: "Pipeline", link: "/architecture/pipeline" },
            { text: "Output Artifacts", link: "/architecture/output" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Invariants", link: "/reference/invariants" },
          ],
        },
      ],
    },
    socialLinks: [],
    footer: {
      message: "TrajRx — Trajectory + Rx",
      copyright: "MIT License",
    },
    search: {
      provider: "local",
    },
  },
});
