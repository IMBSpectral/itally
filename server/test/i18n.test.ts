import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lang, setLang, t, transliterate } from '../../src/i18n'

test('the screens in Hindi; what has no translation stays as it is', () => {
  assert.equal(lang(), 'en') // no browser storage here: English
  assert.equal(t('Balance Sheet'), 'Balance Sheet')
  setLang('hi')
  assert.equal(t('Balance Sheet'), 'तुलन पत्र')
  assert.equal(t('Home'), 'होम')
  assert.equal(t('GSTR-1'), 'GSTR-1')
  setLang('en')
  assert.equal(t('Day Book'), 'Day Book')
})

test('transliteration: Roman letters to Devanagari, ITRANS-like', () => {
  const cases: [string, string][] = [
    ['Sharma', 'शर्मा'], ['Raam', 'राम'], ['Gupta', 'गुप्ता'], ['Kumaar', 'कुमार'], ['vidyaa', 'विद्या'], ['krishna', 'कृश्ना'],
    ['Shree Ganesh', 'श्री गनेश'], ['Mumbai', 'मुम्बै'], ['kShetra', 'क्षेत्रा'], ['aaM', 'आं'],
  ]
  for (const [roman, dev] of cases) assert.equal(transliterate(roman), dev, roman)
  assert.equal(transliterate('Agarwal & Sons 2'), 'अगर्वल & सोन्स 2') // digits and signs stay
  assert.equal(transliterate('राम'), 'राम')
})
