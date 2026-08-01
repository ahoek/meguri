import sharp from 'sharp'
import { readFileSync } from 'node:fs'

const svg = readFileSync(new URL('../public/favicon.svg', import.meta.url))

// Maskable variant: same mark, no rounded corners, mark scaled into safe zone.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#34d399"/>
      <stop offset="1" stop-color="#818cf8"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="#0c111b"/>
  <g transform="translate(256 256) scale(0.78) translate(-256 -256)">
    <circle cx="256" cy="256" r="132" fill="none" stroke="url(#g)" stroke-width="52"
            stroke-linecap="round" stroke-dasharray="622 208" transform="rotate(118 256 256)"/>
    <circle cx="256" cy="388" r="44" fill="#ffffff"/>
  </g>
</svg>`

const out = (name) => new URL(`../public/${name}`, import.meta.url).pathname

await sharp(svg).resize(192, 192).png().toFile(out('pwa-192.png'))
await sharp(svg).resize(512, 512).png().toFile(out('pwa-512.png'))
await sharp(svg).resize(180, 180).png().toFile(out('apple-touch-icon.png'))
await sharp(Buffer.from(maskable)).resize(512, 512).png().toFile(out('pwa-maskable-512.png'))

console.log('icons written')
