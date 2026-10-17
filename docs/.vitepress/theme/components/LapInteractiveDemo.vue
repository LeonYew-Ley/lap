<script setup>
import { withBase } from 'vitepress'
</script>

<template>
  <section class="lap-demo" aria-label="Try Lap photo manager">
    <h2>Try Lap</h2>
    <p>Explore Lap with 20 sample photos. This interactive demo is for reference; the interface and features may differ from the actual app.</p>
    <iframe :src="withBase('/demos/lap/index.html')" title="Lap interactive photo manager demo" loading="lazy" allowfullscreen />
    <a :href="withBase('/demos/lap/index.html')" target="_blank" rel="noopener">Open interactive demo ↗</a>
  </section>
</template>

<style scoped>
.lap-demo { max-width: 1152px; margin: 32px auto 48px; padding: 0 24px; }
h2 { margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
p { margin: 0 0 20px; color: var(--vp-c-text-2); }
iframe { display: block; width: 100%; height: 790px; border: 1px solid var(--vp-c-divider); border-radius: 18px; background: #111318; }
a { display: inline-block; margin-top: 10px; font-size: 13px; color: var(--vp-c-brand-1); }
@media (max-width: 600px) { .lap-demo { padding: 0 16px; } iframe { height: 790px; } }
</style>
