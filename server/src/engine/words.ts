import type { Paise } from './money'

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

/** 0–99 in words. */
function upTo99(n: number) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`
}

/** 0–999 in words. */
function upTo999(n: number) {
  const h = Math.floor(n / 100)
  const rest = n % 100
  return [h ? `${ONES[h]} Hundred` : '', rest ? upTo99(rest) : ''].filter(Boolean).join(' ')
}

/** A whole number in the Indian system: crore, lakh, thousand, hundred. */
export function numberInWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Cannot say ${n} in words`)
  if (n === 0) return 'Zero'
  const crore = Math.floor(n / 10_000_000)
  const lakh = Math.floor((n % 10_000_000) / 100_000)
  const thousand = Math.floor((n % 100_000) / 1000)
  const rest = n % 1000
  return [
    crore ? `${numberInWords(crore)} Crore` : '', // crores beyond 99 repeat the system ("One Hundred Crore")
    lakh ? `${upTo99(lakh)} Lakh` : '',
    thousand ? `${upTo99(thousand)} Thousand` : '',
    rest ? upTo999(rest) : '',
  ].filter(Boolean).join(' ')
}

/** "Rupees Twelve Lakh Thirty Four Thousand ... and Eighty Nine Paise Only", as on Indian vouchers. */
export function amountInWords(p: Paise): string {
  const abs = Math.abs(p)
  const rupees = Math.floor(abs / 100)
  const paise = abs % 100
  const parts = [rupees ? `Rupees ${numberInWords(rupees)}` : '', paise ? `${numberInWords(paise)} Paise` : ''].filter(Boolean)
  return parts.length ? `${parts.join(' and ')} Only` : 'Rupees Zero Only'
}
