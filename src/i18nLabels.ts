/**
 * Hindi for the words on forms and reports: field labels, column headings, section headings and
 * buttons. Applied to the page by i18nDom.ts; statutory terms (GSTR tables, PF, ESI) stay in English.
 */
export const HI_LABELS: Record<string, string> = {
  // common fields
  Name: 'नाम', Under: 'अंतर्गत', Group: 'समूह', Ledger: 'खाता', Date: 'दिनांक', From: 'से', To: 'तक', Type: 'प्रकार', Amount: 'राशि', Rate: 'दर',
  'Rate %': 'दर %', Quantity: 'मात्रा', Value: 'मूल्य', Total: 'कुल', Particulars: 'विवरण', Narration: 'विवरण', Debit: 'नामे', Credit: 'जमा', 'Dr/Cr': 'नामे/जमा',
  'Debit Amount': 'नामे राशि', 'Credit Amount': 'जमा राशि', Balance: 'शेष', Opening: 'प्रारंभिक', Closing: 'अंतिम', 'Opening Balance': 'प्रारंभिक शेष',
  'Opening balance': 'प्रारंभिक शेष', 'Closing Balance': 'अंतिम शेष', 'Closing balance': 'अंतिम शेष', Party: 'पार्टी', "Party's Name": 'पार्टी का नाम',
  'Party A/c name': 'पार्टी खाता', Address: 'पता', 'Address (the last line is the town)': 'पता (अंतिम पंक्ति में शहर)', State: 'राज्य', Country: 'देश',
  'PIN code': 'पिन कोड', Phone: 'फ़ोन', 'E-mail': 'ई-मेल', PAN: 'पैन', GSTIN: 'जीएसटीआईएन', 'GSTIN/UIN': 'जीएसटीआईएन/यूआईएन', 'Mailing name': 'डाक नाम',
  'Mailing details': 'डाक विवरण', Description: 'विवरण', Status: 'स्थिति', Note: 'टिप्पणी', Reference: 'संदर्भ', 'Ref. No.': 'संदर्भ सं.', Code: 'कोड',
  Category: 'श्रेणी', Unit: 'इकाई', Units: 'इकाइयाँ', Symbol: 'चिह्न', 'Formal name': 'औपचारिक नाम', 'Decimal places': 'दशमलव स्थान',
  'Number of decimal places': 'दशमलव स्थानों की संख्या', 'First unit': 'पहली इकाई', 'Second unit': 'दूसरी इकाई', Conversion: 'रूपांतरण',
  'Company name': 'कंपनी का नाम', 'Books beginning from': 'बही आरंभ तिथि', Month: 'माह', Days: 'दिन', 'As on': 'तिथि तक', Version: 'संस्करण',
  // masters
  'Name of group': 'समूह का नाम', 'Name of ledger': 'खाते का नाम', 'Name of Item': 'आइटम का नाम', 'Name of bank': 'बैंक का नाम', 'Name of Cost Centre': 'लागत केंद्र का नाम',
  'Name of voucher type': 'वाउचर प्रकार का नाम', 'Name of classification': 'वर्गीकरण का नाम', 'Maintain balances bill-by-bill': 'बिल-वार शेष रखें',
  'Default credit period (days)': 'सामान्य उधार अवधि (दिन)', 'Cost centres are applicable': 'लागत केंद्र लागू', 'Interest rate (% a year)': 'ब्याज दर (% वार्षिक)',
  'Calculate interest on': 'ब्याज की गणना', 'Currency of ledger': 'खाते की मुद्रा', 'Stock Item': 'स्टॉक आइटम', 'Stock item': 'स्टॉक आइटम', Godown: 'गोदाम',
  'Maintain in batches': 'बैच में रखें', 'Reorder level': 'पुनः ऑर्डर स्तर', 'Reorder Level': 'पुनः ऑर्डर स्तर', 'Minimum order': 'न्यूनतम ऑर्डर', 'Min. Order': 'न्यूनतम ऑर्डर',
  'Opening Qty': 'प्रारंभिक मात्रा', 'Opening Value': 'प्रारंभिक मूल्य', 'HSN/SAC': 'एचएसएन/एसएसी', 'GST rate': 'जीएसटी दर', 'GST rate (%)': 'जीएसटी दर (%)',
  Taxability: 'कर-योग्यता', 'GST classification': 'जीएसटी वर्गीकरण', 'GST tax type': 'जीएसटी कर प्रकार', 'GST registration': 'जीएसटी पंजीकरण',
  'Registration type': 'पंजीकरण प्रकार', 'Reverse charge (you pay the GST)': 'रिवर्स चार्ज (जीएसटी आप देंगे)', Abbreviation: 'संक्षेप',
  'Method of voucher numbering': 'वाउचर क्रमांकन विधि', Prefix: 'उपसर्ग', Suffix: 'प्रत्यय', 'Starting number': 'आरंभिक संख्या', 'Width (zero-filled)': 'चौड़ाई (शून्य सहित)',
  'Restart numbering each financial year': 'हर वित्त वर्ष क्रमांक फिर से', 'Print title': 'छपाई शीर्षक', 'In use': 'उपयोग में', 'Use for POS invoicing': 'पीओएस बिलिंग हेतु',
  'Select type of voucher': 'वाउचर का प्रकार चुनें', 'Whose stock it holds': 'किसका स्टॉक',
  // vouchers
  Voucher: 'वाउचर', Vouchers: 'वाउचर', 'Voucher No.': 'वाउचर सं.', 'Vch No.': 'वाउचर सं.', 'Vch Type': 'वाउचर प्रकार', Vch: 'वाउचर', Item: 'आइटम',
  'Description of Goods': 'माल का विवरण', per: 'प्रति', Batch: 'बैच', 'Cost track': 'लागत ट्रैक', 'Supplier invoice no.': 'आपूर्तिकर्ता बिल सं.',
  'Advance GST rate %': 'अग्रिम जीएसटी दर %', 'Applicable up to': 'तक लागू', 'Type of Ref': 'संदर्भ प्रकार', Bill: 'बिल', Bills: 'बिल', 'Bill date': 'बिल तिथि',
  'Bill-wise': 'बिल-वार', 'Pending bills': 'लंबित बिल', 'On Account': 'खाते पर', Advance: 'अग्रिम', 'Cheque No.': 'चेक सं.', 'Cheque Date': 'चेक तिथि',
  'Cheque date': 'चेक तिथि', 'Cheque / DD No.': 'चेक / डीडी सं.', 'Bank Date': 'बैंक तिथि', Optional: 'वैकल्पिक', Cancelled: 'रद्द', 'Cancelled on': 'रद्द तिथि',
  // reports
  'Closing Qty': 'अंतिम मात्रा', 'Closing Quantity': 'अंतिम मात्रा', 'Closing Value': 'अंतिम मूल्य', 'Closing value': 'अंतिम मूल्य', Inwards: 'आवक', Outwards: 'जावक',
  'Inwards Qty': 'आवक मात्रा', 'Inwards Value': 'आवक मूल्य', 'Outwards Qty': 'जावक मात्रा', 'Outwards Value': 'जावक मूल्य', 'Inward Qty': 'आवक मात्रा',
  'Inward Value': 'आवक मूल्य', 'Outward Qty': 'जावक मात्रा', 'Outward Value': 'जावक मूल्य', 'Avg. Rate': 'औसत दर', 'In stock': 'स्टॉक में', Assets: 'परिसंपत्तियाँ',
  Liabilities: 'देनदारियाँ', 'Sources of Funds': 'निधि के स्रोत', 'Application of Funds': 'निधि का उपयोग', 'Principal Groups': 'प्रमुख समूह',
  'Principal Ratios': 'प्रमुख अनुपात', Inflow: 'आवक', Outflow: 'जावक', 'Nett Flow': 'शुद्ध प्रवाह', Pending: 'लंबित', 'Pending Amount': 'लंबित राशि',
  'Pending value': 'लंबित मूल्य', 'Due on': 'देय तिथि', Due: 'देय', 'Due from': 'देय तिथि से', 'Overdue by days': 'अतिदेय (दिन)', 'Overdue by': 'अतिदेय',
  'Days overdue': 'अतिदेय दिन', 'Of which overdue': 'जिसमें अतिदेय', Ordered: 'ऑर्डर किया', Delivered: 'दिया गया', Received: 'प्राप्त', Issued: 'जारी',
  'Order No.': 'ऑर्डर सं.', 'Order No(s).': 'ऑर्डर सं.', 'Note No.': 'नोट सं.', 'Not invoiced': 'बिना बिल', Actual: 'वास्तविक', Variance: 'अंतर', Budget: 'बजट',
  'Budget for': 'बजट किसके लिए', 'Type of budget': 'बजट का प्रकार', Scenario: 'परिदृश्य', 'Include actuals': 'वास्तविक शामिल करें', Include: 'शामिल',
  Margin: 'मार्जिन', 'Margin %': 'मार्जिन %', Costs: 'लागत', Sales: 'बिक्री', 'Goods in': 'आवक माल', 'Goods out': 'जावक माल', Paid: 'भुगतान किया',
  Payable: 'देय', Payment: 'भुगतान', Payments: 'भुगतान', Deducted: 'काटा गया', Interest: 'ब्याज', Tax: 'कर', Taxable: 'कर-योग्य', 'Taxable Value': 'कर-योग्य मूल्य',
  'Place of supply': 'आपूर्ति का स्थान', 'Entered by': 'दर्ज किया', 'Last altered': 'अंतिम संशोधन', Auditor: 'लेखा परीक्षक', Who: 'कौन', When: 'कब', What: 'क्या',
  Show: 'दिखाएँ', Document: 'दस्तावेज़', Supplier: 'आपूर्तिकर्ता', 'Expires on': 'समाप्ति तिथि', 'Made on': 'निर्माण तिथि', Expiry: 'समाप्ति',
  'Value as on': 'मूल्य, तिथि तक', Count: 'गिनती', Turnover: 'कारोबार', Section: 'धारा', Challan: 'चालान', 'Challan No.': 'चालान सं.', Mode: 'तरीका',
  'Employee': 'कर्मचारी', Employees: 'कर्मचारी', Earnings: 'आय', Deductions: 'कटौतियाँ', 'Net pay': 'शुद्ध वेतन', 'Gross salary': 'सकल वेतन',
  'Pay head': 'वेतन मद', 'Pay head type': 'वेतन मद प्रकार', 'Effective from': 'से प्रभावी', Gender: 'लिंग', Joined: 'नियुक्ति', Left: 'छोड़ा',
  // buttons and actions
  Create: 'बनाएँ', Change: 'बदलें', Apply: 'लागू करें', Import: 'आयात', Delete: 'हटाएँ', Cancel: 'रद्द करें', Back: 'वापस', 'Download the template': 'नमूना डाउनलोड करें',
  'Add line': 'पंक्ति जोड़ें', 'Add ledger line': 'खाता पंक्ति जोड़ें', 'Post-dated': 'उत्तर-दिनांकित', 'Not optional': 'वैकल्पिक नहीं', 'Make regular': 'नियमित करें',
  // users and settings
  User: 'उपयोगकर्ता', 'User name': 'उपयोगकर्ता नाम', Password: 'पासवर्ड', 'Repeat password': 'पासवर्ड दोहराएँ', 'Current password': 'वर्तमान पासवर्ड',
  'Show current balances of ledgers in voucher entry': 'वाउचर में खातों का चालू शेष दिखाएँ', 'Warn on negative cash and bank balances': 'नकद/बैंक ऋणात्मक होने पर चेतावनी',
  'Show narrations in the Day Book': 'दैनिक बही में विवरण दिखाएँ', 'Save the layout': 'लेआउट सहेजें', 'Post receipt': 'प्राप्ति दर्ज करें', 'Mark audited': 'ऑडिट किया',
  'New password': 'नया पासवर्ड', 'Repeat new password': 'नया पासवर्ड दोहराएँ', Role: 'भूमिका', 'Date of a new voucher': 'नए वाउचर की तिथि', Subject: 'विषय', Message: 'संदेश',
}
