/**
 * Languages, as Tally's: the screens' menus, titles and buttons in Hindi or English (chosen per
 * computer in F12), and transliteration, typing names in Roman letters to have them in Devanagari
 * (ITRANS-like: "Sharma" शर्मा, "Raam" राम, "kShetra" क्षेत्र). What is not translated stays in
 * English, as Tally keeps terms like GSTR-1 and TDS.
 */

export type Lang = 'en' | 'hi'
export const LANGUAGES: Record<Lang, string> = { en: 'English', hi: 'हिन्दी (Hindi)' }

const KEY = 'tally.lang'
let current: Lang = (() => {
  try {
    return (localStorage.getItem(KEY) as Lang) || 'en'
  } catch {
    return 'en'
  }
})()
export const lang = () => current
export function setLang(l: Lang) {
  current = l
  try {
    localStorage.setItem(KEY, l)
  } catch {
    // a private window: the choice lasts until the page closes
  }
}

const HI: Record<string, string> = {
  // the Gateway of Tally and its sections
  Home: 'होम', 'Current Period': 'चालू अवधि', 'Current Date': 'आज की तिथि', 'Name of Company': 'कंपनी का नाम', 'Date of Last Entry': 'अंतिम प्रविष्टि की तिथि', Open: 'खोलें', Masters: 'मास्टर्स', Create: 'बनाएँ', Alter: 'बदलें', 'Chart of Accounts': 'खातों की सूची', Transactions: 'लेन-देन',
  Vouchers: 'वाउचर', 'Day Book': 'दैनिक बही', Banking: 'बैंकिंग', Reports: 'रिपोर्ट', 'Balance Sheet': 'तुलन पत्र', 'Profit & Loss A/c': 'लाभ-हानि खाता',
  'Stock Summary': 'स्टॉक सारांश', 'Ratio Analysis': 'अनुपात विश्लेषण', Dashboard: 'डैशबोर्ड', 'Display More Reports': 'और रिपोर्ट देखें', Quit: 'बाहर निकलें',
  'Master Creation': 'मास्टर बनाएँ', 'Master Alteration': 'मास्टर बदलें', 'Change Voucher Type': 'वाउचर प्रकार बदलें', Company: 'कंपनी',
  // masters
  'Accounting Masters': 'लेखा मास्टर्स', 'Inventory Masters': 'स्टॉक मास्टर्स', 'Statutory Masters': 'वैधानिक मास्टर्स', 'Payroll Masters': 'वेतन मास्टर्स',
  Group: 'समूह', Ledger: 'खाता', 'Cost Category': 'लागत श्रेणी', 'Cost Centre': 'लागत केंद्र', 'Voucher Type': 'वाउचर प्रकार', Currency: 'मुद्रा',
  'Rates of Exchange': 'विनिमय दरें', Budget: 'बजट', Scenario: 'परिदृश्य', 'Stock Group': 'स्टॉक समूह', 'Stock Item': 'स्टॉक आइटम', 'Stock Category': 'स्टॉक श्रेणी',
  Unit: 'इकाई', 'Bill of Materials': 'सामग्री सूची', Godown: 'गोदाम', 'GST Classification': 'जीएसटी वर्गीकरण', 'TDS Nature of Payment': 'टीडीएस भुगतान का प्रकार',
  'TCS Nature of Goods': 'टीसीएस माल का प्रकार', 'Employee Category': 'कर्मचारी श्रेणी', 'Employee Group': 'कर्मचारी समूह', Employee: 'कर्मचारी',
  'Attendance/Production Type': 'उपस्थिति/उत्पादन प्रकार', 'Pay Head': 'वेतन मद', 'Salary Details': 'वेतन विवरण', 'Closing Stock': 'अंतिम स्टॉक',
  // reports
  Accounting: 'लेखा', Inventory: 'स्टॉक', Statutory: 'वैधानिक', 'Trial Balance': 'तलपट', 'Cash Flow': 'नकद प्रवाह', 'Funds Flow': 'निधि प्रवाह',
  'Account Books': 'लेखा बहियाँ', 'Statements of Accounts': 'खातों के विवरण', 'Inventory Books': 'स्टॉक बहियाँ', 'Statements of Inventory': 'स्टॉक के विवरण',
  'GST Reports': 'जीएसटी रिपोर्ट', 'TDS Reports': 'टीडीएस रिपोर्ट', 'TCS Reports': 'टीसीएस रिपोर्ट', 'MSME Reports': 'एमएसएमई रिपोर्ट', 'Payroll Reports': 'वेतन रिपोर्ट',
  'Payroll Statutory Reports': 'वेतन वैधानिक रिपोर्ट', 'Job Work Reports': 'जॉब वर्क रिपोर्ट', 'Budget Variance': 'बजट अंतर', 'Tally Audit': 'टैली ऑडिट',
  'Cost Tracking': 'लागत ट्रैकिंग', 'Exception Reports': 'अपवाद रिपोर्ट', 'Edit Log': 'संपादन लॉग', 'Cash/Bank Books': 'नकद/बैंक बही', 'Group Summary': 'समूह सारांश',
  'Group Vouchers': 'समूह वाउचर', 'Contra Register': 'कॉन्ट्रा रजिस्टर', 'Payment Register': 'भुगतान रजिस्टर', 'Receipts Register': 'प्राप्ति रजिस्टर',
  'Sales Register': 'बिक्री रजिस्टर', 'Purchase Register': 'खरीद रजिस्टर', 'Journal Register': 'जर्नल रजिस्टर', 'Debit Note Register': 'डेबिट नोट रजिस्टर',
  'Credit Note Register': 'क्रेडिट नोट रजिस्टर', 'POS Register': 'पीओएस रजिस्टर', Outstandings: 'बकाया', Receivables: 'प्राप्य', Payables: 'देय',
  'Ledger Break-up': 'खाता अनुसार', 'Group Break-up': 'समूह अनुसार', 'Cost Centres': 'लागत केंद्र', 'Category Summary': 'श्रेणी सारांश',
  'Cost Centre Break-up': 'लागत केंद्र अनुसार', 'Interest Calculations': 'ब्याज गणना', 'Interest Receivable': 'प्राप्य ब्याज', 'Interest Payable': 'देय ब्याज',
  Statistics: 'आँकड़े', 'Stock Query': 'स्टॉक पूछताछ', Godowns: 'गोदाम', 'Movement Analysis': 'आवाजाही विश्लेषण', 'Ageing Analysis': 'आयु विश्लेषण',
  'Reorder Status': 'पुनः ऑर्डर स्थिति', 'Cost Estimation': 'लागत अनुमान', 'Batches (expiry)': 'बैच (समाप्ति)', 'Order Outstandings': 'बकाया ऑर्डर',
  'Sales Orders': 'बिक्री ऑर्डर', 'Purchase Orders': 'खरीद ऑर्डर', 'Sales Order Analysis (by month)': 'बिक्री ऑर्डर विश्लेषण (मासिक)',
  'Purchase Order Analysis (by month)': 'खरीद ऑर्डर विश्लेषण (मासिक)', 'Bills Pending': 'लंबित बिल', 'Sales Bills Pending': 'लंबित बिक्री बिल',
  'Purchase Bills Pending': 'लंबित खरीद बिल', 'Stock Group Summary': 'स्टॉक समूह सारांश', 'Stock Category Summary': 'स्टॉक श्रेणी सारांश', 'Godown Summary': 'गोदाम सारांश',
  'Overdue Receivables': 'अतिदेय प्राप्य', 'Overdue Payables': 'अतिदेय देय', 'Negative Ledgers': 'ऋणात्मक खाते', 'Negative Stock': 'ऋणात्मक स्टॉक',
  'Cancelled Vouchers': 'रद्द वाउचर', 'Post-Dated Vouchers': 'उत्तर-दिनांकित वाउचर', 'Optional Vouchers': 'वैकल्पिक वाउचर', 'Memorandum Register': 'स्मरण रजिस्टर',
  'Reversing Journal Register': 'प्रतिवर्ती जर्नल रजिस्टर', 'Tracked Vouchers (notes not invoiced)': 'ट्रैक किए वाउचर (बिना बिल के नोट)', 'Forex Gain/Loss': 'विदेशी मुद्रा लाभ/हानि',
  'Cheque Printing': 'चेक छपाई', 'Cheque Register': 'चेक रजिस्टर', 'Post-Dated Summary': 'उत्तर-दिनांकित सारांश', 'Deposit Slip': 'जमा पर्ची',
  'Payment Advice': 'भुगतान सूचना', Reconcile: 'मिलान', 'Bank Reconciliation': 'बैंक मिलान', 'Payment Gateway Reconciliation': 'पेमेंट गेटवे मिलान',
  'TDS Computation': 'टीडीएस गणना', 'TDS Outstandings': 'बकाया टीडीएस', 'TCS Computation': 'टीसीएस गणना', 'TCS Outstandings': 'बकाया टीसीएस',
  'Challan Reconciliation': 'चालान मिलान', 'TDS Details': 'टीडीएस विवरण', 'TDS/TCS Details': 'टीडीएस/टीसीएस विवरण', 'GST Registration': 'जीएसटी पंजीकरण',
  'Party GSTIN Update': 'पार्टी जीएसटीआईएन अद्यतन', 'Advances (11A/11B)': 'अग्रिम (11A/11B)', 'GSTR-9 Annual Return': 'GSTR-9 वार्षिक रिटर्न',
  'GSTR-2B Reconciliation and IMS': 'GSTR-2B मिलान और IMS', 'GSTR-1 Reconciliation': 'GSTR-1 मिलान', 'MSME Form 1': 'एमएसएमई फॉर्म 1', 'Party MSME Update': 'पार्टी एमएसएमई अद्यतन',
  'Kerala Flood Cess (2019-21)': 'केरल बाढ़ उपकर (2019-21)', 'Pay Sheet': 'वेतन पत्रक', Payslip: 'वेतन पर्ची', 'Attendance Sheet': 'उपस्थिति पत्रक',
  'Payroll Register': 'वेतन रजिस्टर', 'Statements of Payroll': 'वेतन विवरण', Gratuity: 'उपदान', 'Professional Tax': 'व्यवसाय कर',
  'Provident Fund (ECR)': 'भविष्य निधि (ECR)', 'National Pension System': 'राष्ट्रीय पेंशन प्रणाली', Registers: 'रजिस्टर',
  // company and data
  'Company Details': 'कंपनी विवरण', 'Features (F11)': 'सुविधाएँ (F11)', Security: 'सुरक्षा', 'Users and Passwords': 'उपयोगकर्ता और पासवर्ड',
  'Change Password': 'पासवर्ड बदलें', 'E-mail Settings': 'ई-मेल सेटिंग', 'E-mail Log': 'ई-मेल लॉग', Data: 'डेटा', 'Select Company': 'कंपनी चुनें',
  'Create Company': 'कंपनी बनाएँ', 'Configuration (F12)': 'विन्यास (F12)', 'Import from Excel': 'एक्सेल से आयात', 'Split Company Data': 'कंपनी डेटा विभाजन',
  // vouchers and buttons
  Contra: 'कॉन्ट्रा', Payment: 'भुगतान', Receipt: 'प्राप्ति', Journal: 'जर्नल', Sales: 'बिक्री', Purchase: 'खरीद', 'Credit Note': 'क्रेडिट नोट',
  'Debit Note': 'डेबिट नोट', 'Sales Order': 'बिक्री ऑर्डर', 'Purchase Order': 'खरीद ऑर्डर', 'Delivery Note': 'डिलीवरी नोट', 'Receipt Note': 'प्राप्ति नोट',
  'Stock Journal': 'स्टॉक जर्नल', 'Physical Stock': 'भौतिक स्टॉक', Memorandum: 'स्मरण', Payroll: 'वेतन', Attendance: 'उपस्थिति', 'Reversing Journal': 'प्रतिवर्ती जर्नल',
  'Manufacturing Journal': 'निर्माण जर्नल', Period: 'अवधि', Print: 'छापें', Export: 'निर्यात', 'E-mail': 'ई-मेल', 'Other Vouchers': 'अन्य वाउचर', Back: 'वापस',
  'Accounting Voucher Creation': 'लेखा वाउचर बनाएँ', 'Invoice Creation': 'बीजक बनाएँ', Alteration: 'संशोधन', Narration: 'विवरण', Accept: 'स्वीकारें', Save: 'सहेजें',
  Date: 'दिनांक', Particulars: 'विवरण', Debit: 'नामे', Credit: 'जमा', Total: 'कुल', 'Ledger Creation': 'खाता बनाएँ', 'Ledger Alteration': 'खाता बदलें',
  'Stock Item Creation': 'स्टॉक आइटम बनाएँ', 'Group Creation': 'समूह बनाएँ', 'Language (this computer)': 'भाषा (यह कंप्यूटर)',
}

/** The screen text in the chosen language; text with no translation stays as it is. */
export function t(text: string): string {
  if (current === 'en' || !text) return text
  return HI[text] ?? HI[text.trim()] ?? text
}

// ------------------------------------------------------------------ transliteration (Roman to Devanagari)

const VOWELS: [string, string, string][] = [
  // typed, as a letter, as a sign after a consonant
  ['aa', 'आ', 'ा'], ['ai', 'ऐ', 'ै'], ['au', 'औ', 'ौ'], ['ee', 'ई', 'ी'], ['ii', 'ई', 'ी'], ['oo', 'ऊ', 'ू'], ['uu', 'ऊ', 'ू'], ['ri', 'ऋ', 'ृ'],
  ['A', 'आ', 'ा'], ['I', 'ई', 'ी'], ['U', 'ऊ', 'ू'], ['a', 'अ', ''], ['i', 'इ', 'ि'], ['u', 'उ', 'ु'], ['e', 'ए', 'े'], ['o', 'ओ', 'ो'],
]
const CONSONANTS: [string, string][] = [
  ['ksh', 'क्ष'], ['kSh', 'क्ष'], ['chh', 'छ'], ['shr', 'श्र'], ['gy', 'ज्ञ'], ['jn', 'ज्ञ'],
  ['kh', 'ख'], ['gh', 'घ'], ['ch', 'च'], ['jh', 'झ'], ['Th', 'ठ'], ['Dh', 'ढ'], ['th', 'थ'], ['dh', 'ध'], ['ph', 'फ'], ['bh', 'भ'],
  ['sh', 'श'], ['Sh', 'ष'], ['ng', 'ङ'], ['ny', 'ञ'],
  ['k', 'क'], ['g', 'ग'], ['c', 'क'], ['j', 'ज'], ['T', 'ट'], ['D', 'ड'], ['N', 'ण'], ['t', 'त'], ['d', 'द'], ['n', 'न'], ['p', 'प'], ['f', 'फ़'],
  ['b', 'ब'], ['m', 'म'], ['y', 'य'], ['r', 'र'], ['l', 'ल'], ['v', 'व'], ['w', 'व'], ['s', 'स'], ['h', 'ह'], ['z', 'ज़'], ['q', 'क़'], ['x', 'क्स'],
]
const HALANT = '्'

/** One word in Roman letters to Devanagari. A word-final "a" after a consonant is long (Sharma शर्मा), as Indian names are written. */
function word(typed: string): string {
  // a capital starting a name is just a capital; capitals inside a word mean what ITRANS says (kShetra)
  const w = /^[A-Z][^A-Z]*$/.test(typed) ? typed.toLowerCase() : typed
  let out = ''
  let i = 0
  let afterConsonant = false
  while (i < w.length) {
    if (w[i] === 'M' || (w[i] === '.' && w[i + 1] === 'n')) {
      out += 'ं'
      i += w[i] === 'M' ? 1 : 2
      afterConsonant = false
      continue
    }
    if (w[i] === 'H') {
      out += 'ः'
      i++
      afterConsonant = false
      continue
    }
    const v = VOWELS.find(([k]) => w.startsWith(k, i))
    if (v) {
      const last = i + v[0].length >= w.length
      if (afterConsonant) out += v[0] === 'a' && last && i > 1 ? 'ा' : v[2]
      else out += v[1]
      i += v[0].length
      afterConsonant = false
      continue
    }
    const c = CONSONANTS.find(([k]) => w.startsWith(k, i))
    if (c) {
      if (afterConsonant) out += HALANT
      out += c[1]
      i += c[0].length
      afterConsonant = true
      continue
    }
    out += w[i]
    i++
    afterConsonant = false
  }
  return out
}

/** Text in Roman letters to Devanagari, word by word; digits and punctuation stay. */
export const transliterate = (text: string) => text.replace(/[A-Za-z.]+/g, (w) => word(w))
