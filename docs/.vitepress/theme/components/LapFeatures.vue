<script setup>
import { withBase } from 'vitepress'

const photo = (id) => withBase(`/demos/lap/thumbnails/${id}.jpg`)
const groups = [
  { title: 'A place for every photo.', label: 'MANAGE & ORGANIZE', items: [
    ['Folders & smart albums', 'Use your existing folders, save matching rules, and gather favorites in collections.'],
    ['People & tags', 'Name people, browse their photos, and keep related tags together.'],
    ['Review & batch tools', 'Rate, pick, reject, and rename multiple files in one go.'],
    ['Offline browsing', 'Explore cached thumbnails and metadata even when your drive is disconnected.'],
  ] },
  { title: 'More ways to enjoy them.', label: 'EXPLORE & CREATE', items: [
    ['RAW & paired photos', 'Choose your RAW preview and switch to the paired JPEG or HEIC.'],
    ['Map & calendar', 'Rediscover photos by where and when they were taken.'],
    ['Motion & collage', 'Play supported Live and Motion Photos, or turn a selection into a collage.'],
    ['Local & private', 'Keep your library and AI processing on your device, without forced cloud uploads.'],
  ] },
]
</script>

<template>
  <section class="lap-features" aria-labelledby="features-heading">
    <header class="features-heading">
      <p class="eyebrow">MADE FOR YOUR PHOTO LIBRARY</p>
      <h2 id="features-heading">Your photos. Better organized.</h2>
      <p>Find the ones you love. Make room for what comes next.</p>
    </header>

    <div class="spotlights">
      <article class="spotlight search">
        <div class="spotlight-copy">
          <p class="eyebrow">LOCAL AI SEARCH</p>
          <h3>A memory is all you need.</h3>
          <p>Describe a photo or start with a similar image.<br class="desktop-break" /> Find it with AI that runs on your device.</p>
        </div>
        <div class="search-preview" role="img" aria-label="Illustration of a birds search with three sample photos">
          <div class="query"><span>Birds in nature</span><span class="query-label">Local AI</span></div>
          <div class="search-photos">
            <img :src="photo('10')" alt="A small bird on a branch" loading="lazy" />
            <img :src="photo('11')" alt="A bird flying over mountains" loading="lazy" />
            <img :src="photo('16')" alt="A colorful bird" loading="lazy" />
          </div>
          <p class="preview-note">Illustrative preview</p>
        </div>
      </article>
      <article class="spotlight cleanup">
        <div class="spotlight-copy">
          <p class="eyebrow">DUPLICATES & SIMILAR PHOTOS</p>
          <h3>Keep the best.<br />Clear the rest.</h3>
          <p>Compare duplicates and similar shots, choose what to keep, and tidy up your library.</p>
        </div>
        <div class="duplicate-preview" role="img" aria-label="Illustration of two duplicate photos with one marked Keep">
          <figure><img :src="photo('08')" alt="Golden fields" loading="lazy" /><figcaption>Keep</figcaption></figure>
          <figure><img :src="photo('08')" alt="A duplicate of Golden fields" loading="lazy" /><figcaption>Duplicate</figcaption></figure>
        </div>
        <p class="preview-note">Illustrative preview</p>
      </article>
    </div>

    <div class="feature-groups">
      <section v-for="group in groups" :key="group.label" class="feature-group">
        <p class="eyebrow">{{ group.label }}</p>
        <h3>{{ group.title }}</h3>
        <dl>
          <div v-for="[title, description] in group.items" :key="title" class="feature-row">
            <dt>{{ title }}</dt><dd>{{ description }}</dd>
          </div>
        </dl>
      </section>
    </div>
  </section>
</template>

<style scoped>
.lap-features { max-width: 1152px; margin: 96px auto 112px; padding: 0 24px; }
.features-heading { margin-bottom: 36px; }
.eyebrow { font-size: 11px; letter-spacing: .12em; font-weight: 600; color: var(--vp-c-text-2); }
h2 { margin: 12px 0 16px; font-size: clamp(30px, 3.5vw, 42px); line-height: 1.15; letter-spacing: -.035em; font-weight: 600; }
.features-heading > p:last-child { color: var(--vp-c-text-2); font-size: 17px; }
.spotlights { display: grid; grid-template-columns: 1.45fr 1fr; gap: 20px; }
.spotlight { border: 1px solid var(--vp-c-divider); border-radius: 16px; background: var(--vp-c-bg-soft); overflow: hidden; }
.spotlight-copy { padding: 32px 32px 24px; }
.spotlight h3 { margin: 14px 0; font-size: 30px; line-height: 1.15; font-weight: 600; letter-spacing: -.025em; }
.spotlight-copy > p:last-child { color: var(--vp-c-text-2); font-size: 15px; line-height: 1.7; }
.search-preview { margin: 0 32px; }
.query { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; background: var(--vp-c-bg); border: 1px solid var(--vp-c-divider); border-radius: 8px; font-size: 14px; }
.query-label { color: var(--vp-c-text-2); font-size: 11px; white-space: nowrap; }
.search-photos { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.search-photos img { width: 100%; height: 150px; object-fit: cover; border-radius: 6px; }
.preview-note { margin: 12px 0 20px; font-size: 10px; color: var(--vp-c-text-3); }
.duplicate-preview { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0 32px; }
figure { margin: 0; position: relative; overflow: hidden; border-radius: 6px; }
figure img { width: 100%; height: 155px; object-fit: cover; }
figcaption { position: absolute; left: 8px; bottom: 8px; background: #fff; color: #222; padding: 1px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; }
.cleanup > .preview-note { margin-left: 32px; }
.feature-groups { display: grid; grid-template-columns: 1fr 1fr; gap: 72px; margin-top: 72px; }
.feature-group h3 { margin: 12px 0 28px; font-size: 25px; line-height: 1.25; letter-spacing: -.025em; font-weight: 600; }
.feature-row { border-top: 1px solid var(--vp-c-divider); padding: 20px 0; }
dt { font-size: 15px; font-weight: 600; }
dd { margin: 6px 0 0; font-size: 14px; line-height: 1.7; color: var(--vp-c-text-2); max-width: 440px; }
@media (max-width: 800px) {
  .spotlights, .feature-groups { grid-template-columns: 1fr; }
  .feature-groups { gap: 36px; margin-top: 48px; }
  .spotlight h3 { font-size: 28px; }
  .search-photos img { height: 170px; }
}
@media (max-width: 480px) {
  .lap-features { padding: 0 24px; margin: 64px auto; }
  .spotlight-copy { padding: 24px; }
  .search-preview, .duplicate-preview { margin: 0 24px; }
  .cleanup > .preview-note { margin-left: 24px; }
  .search-photos img { height: 110px; }
  figure img { height: 130px; }
  .desktop-break { display: none; }
}
</style>
