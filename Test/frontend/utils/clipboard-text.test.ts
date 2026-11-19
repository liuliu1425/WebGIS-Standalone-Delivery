// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { recoverMislabeledHtmlClipboardText as recover } from '@/utils/clipboard-text'

const reported = '敖獲潩㩮⸰ഹ匊慴瑲呈䱍〺〰〰〰〱വ䔊摮呈䱍〺〰〰〰㔲റ匊慴瑲牆条敭瑮〺〰〰〰㐱റ䔊摮牆条敭瑮〺〰〰〰ㄲവ㰊瑨汭ാ㰊潢祤ാ㰊ⴡ匭慴瑲牆条敭瑮ⴭ뺘ꓧ躣뫤ꮍ飦뎹鷥袉ꓦꮢ藥ꚭ軥ꚺ볯뚹裥낈〲㔲맥ㆴ袜㔱韦㲥ⴡ䔭摮牆条敭瑮ⴭാ㰊戯摯㹹਍⼼瑨汭'

function garble(fragment: string) {
  const encoder = new TextEncoder()
  const header = 'Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n'
  const before = '<html><body><!--StartFragment-->'
  const after = '<!--EndFragment--></body></html>'
  const startHtml = header.length
  const start = startHtml + before.length
  const end = start + encoder.encode(fragment).length
  const endHtml = end + after.length
  let filled = header
  for (const [name, value] of Object.entries({ StartHTML: startHtml, EndHTML: endHtml, StartFragment: start, EndFragment: end })) {
    filled = filled.replace(`${name}:0000000000`, `${name}:${String(value).padStart(10, '0')}`)
  }
  const bytes = encoder.encode(filled + before + fragment + after)
  let wrong = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) wrong += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8))
  return wrong
}

describe('mislabeled HTML clipboard recovery', () => {
  it('recovers the exact reported paste, including its missing final HTML byte', () => {
    expect(recover(reported)).toBe('显示风云卫星平均版植被光学厚度，并切到2025年12月15日')
  })
  it.each(['SMAP 土壤水分 m³/m³；等效散射 ω；116.4°', '第一行\n第二行：中文与标点！'])('recovers another fragment: %s', (text) => {
    expect(recover(garble(text))).toBe(text)
  })
  it('extracts rich text as text, preserving line breaks without executable markup', () => {
    expect(recover(garble('<b>显示 SMAP</b><br>ω &amp; VOD<script>bad()</script>'))).toBe('显示 SMAP\nω & VOD')
  })
  it.each(['普通中文与 emoji 🌏', 'Version:0.9\r\nStartHTML:0000000105', '<b>用户要粘贴的原始标签</b>', reported.slice(0, 55), '敖獲潩㩮' + '中文'.repeat(50)])('leaves ordinary or incomplete text to native paste', (text) => {
    expect(recover(text)).toBeNull()
  })
})
