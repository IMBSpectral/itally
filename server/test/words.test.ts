import { test } from 'node:test'
import assert from 'node:assert/strict'
import { amountInWords, numberInWords } from '../src/engine/words'

test('numbers in the Indian system', () => {
  assert.equal(numberInWords(0), 'Zero')
  assert.equal(numberInWords(7), 'Seven')
  assert.equal(numberInWords(19), 'Nineteen')
  assert.equal(numberInWords(40), 'Forty')
  assert.equal(numberInWords(101), 'One Hundred One')
  assert.equal(numberInWords(1000), 'One Thousand')
  assert.equal(numberInWords(100000), 'One Lakh')
  assert.equal(numberInWords(1234567), 'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven')
  assert.equal(numberInWords(10000000), 'One Crore')
  assert.equal(numberInWords(9876543210), 'Nine Hundred Eighty Seven Crore Sixty Five Lakh Forty Three Thousand Two Hundred Ten')
})

test('amounts as written on vouchers', () => {
  assert.equal(amountInWords(123456789), 'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only')
  assert.equal(amountInWords(5000000), 'Rupees Fifty Thousand Only')
  assert.equal(amountInWords(-25), 'Twenty Five Paise Only')
  assert.equal(amountInWords(0), 'Rupees Zero Only')
})
