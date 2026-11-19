// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui'
  ],

  devtools: {
    enabled: true
  },

  app: {
    head: {
      style: [
        {
          innerHTML:
            'html,body{background-color:#ffffff;color:#0f172a;margin:0;}html.dark,html.dark body{background-color:#020617;color:#f1f5f9;}'
        }
      ]
    }
  },

  css: ['~/assets/css/main.css'],

  routeRules: {
    '/mcp': { proxy: `${process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3333'}/mcp` },
    '/mcp/**': { proxy: `${process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3333'}/mcp/**` },
    '/.well-known/**': { proxy: `${process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3333'}/.well-known/**` },
    '/oauth/**': { proxy: `${process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3333'}/oauth/**` },
    '/v1/**': { proxy: `${process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3333'}/v1/**` }
  },

  compatibilityDate: '2026-06-30',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
