// Social posts are passed on unchanged but safe: an allowlist sanitizer for Mastodon post HTML
// and the title of a post row (content warning first, so no subject reveals hidden content).

import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeSocialHtml, socialPostText, socialPostTitle } from '../../src/lib/social/sanitize.mjs'

test('typisches Mastodon-HTML bleibt inhaltlich unverändert, Klassen und Spans entfallen', () => {
  const html = '<p>Hallo <a href="https://social.example/tags/fediverse" class="mention hashtag" rel="tag">#<span>fediverse</span></a>!</p>' +
    '<p>Zeile 1<br />Zeile 2 <a href="https://example.org/artikel" rel="nofollow noopener" target="_blank"><span class="invisible">https://</span><span class="">example.org/artikel</span></a></p>'
  assert.equal(
    sanitizeSocialHtml(html),
    '<p>Hallo <a href="https://social.example/tags/fediverse" rel="noopener noreferrer nofollow">#fediverse</a>!</p>' +
      '<p>Zeile 1<br>Zeile 2 <a href="https://example.org/artikel" rel="noopener noreferrer nofollow">https://example.org/artikel</a></p>'
  )
})

test('Skripte, Styles, iframes, Bilder, Event-Handler und Kommentare werden entfernt', () => {
  const html = '<p onclick="alert(1)">Text</p><script>alert(1)</script><style>p{}</style>' +
    '<iframe src="https://evil.example"></iframe><img src="https://tracker.example/pixel.gif"><!-- versteckt -->' +
    '<svg><script>alert(2)</script></svg><p style="color:red">Ende</p>'
  assert.equal(sanitizeSocialHtml(html), '<p>Text</p><p>Ende</p>')
})

test('nur http(s)-Links bleiben Links; javascript:, data: und relative Links verlieren den Link', () => {
  assert.equal(sanitizeSocialHtml('<a href="javascript:alert(1)">x</a>'), 'x')
  assert.equal(sanitizeSocialHtml('<a href="JaVaScRiPt&#58;alert(1)">x</a>'), 'x')
  assert.equal(sanitizeSocialHtml('<a href="data:text/html,hi">x</a>'), 'x')
  assert.equal(sanitizeSocialHtml('<a href="/relativ">x</a>'), 'x')
  assert.equal(
    sanitizeSocialHtml('<a href="https://ex.org/?a=1&amp;b=&quot;2&quot;">x</a>'),
    '<a href="https://ex.org/?a=1&amp;b=%222%22" rel="noopener noreferrer nofollow">x</a>'
  )
})

test('Text wird dekodiert und neu escaped; kaputte Tags werden nicht zu HTML', () => {
  assert.equal(sanitizeSocialHtml('<p>a &lt;script&gt; &amp; b</p>'), '<p>a &lt;script&gt; &amp; b</p>')
  assert.equal(sanitizeSocialHtml('1 < 2 und <b'), '1 &lt; 2 und &lt;b')
  assert.equal(sanitizeSocialHtml('<p>&#x3C;img src=x onerror=alert(1)&#x3E;</p>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>')
})

test('offene und falsch verschachtelte Tags werden balanciert', () => {
  assert.equal(sanitizeSocialHtml('<p><strong>fett <em>kursiv</p> danach'), '<p><strong>fett <em>kursiv</em></strong></p> danach')
  assert.equal(sanitizeSocialHtml('</p>text</a>'), 'text')
  assert.equal(sanitizeSocialHtml('<a href="https://a.example">eins <a href="https://b.example">zwei</a>'),
    '<a href="https://a.example/" rel="noopener noreferrer nofollow">eins </a><a href="https://b.example/" rel="noopener noreferrer nofollow">zwei</a>')
})

test('Listen, Zitate und Code bleiben erhalten', () => {
  const html = '<blockquote><p>Zitat</p></blockquote><ul><li>eins</li><li>zwei</li></ul><pre><code>x = 1</code></pre>'
  assert.equal(sanitizeSocialHtml(html), html)
})

test('leere oder fehlende Eingaben ergeben einen leeren String', () => {
  assert.equal(sanitizeSocialHtml(''), '')
  assert.equal(sanitizeSocialHtml(null), '')
  assert.equal(sanitizeSocialHtml(undefined), '')
})

test('socialPostText liefert Klartext mit Absätzen', () => {
  assert.equal(socialPostText('<p>Hallo &amp; willkommen</p><p>Zweiter<br>Absatz</p>'), 'Hallo & willkommen\n\nZweiter\nAbsatz')
})

test('Titel: Content-Warning hat Vorrang, sonst Textanfang, sonst neutraler Platzhalter', () => {
  assert.equal(socialPostTitle({ text: 'Geheimer Inhalt', spoiler: 'Politik' }), 'CW: Politik')
  assert.equal(socialPostTitle({ text: 'Kurzer Post\nmit zweiter Zeile', spoiler: '' }), 'Kurzer Post')
  const long = 'Wort '.repeat(40).trim()
  const title = socialPostTitle({ text: long, spoiler: null })
  assert.ok(title.length <= 100, title)
  assert.ok(title.endsWith('…'))
  assert.equal(socialPostTitle({ text: '', spoiler: null, hasMedia: true }), 'Beitrag mit Medien')
  assert.equal(socialPostTitle({ text: '   ', spoiler: null }), 'Beitrag')
})
