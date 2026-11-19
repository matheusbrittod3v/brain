// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  routeRules: {
    '/': { ssr: false },
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
