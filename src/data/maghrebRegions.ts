/**
 * Single source of truth for the Maghreb region lists across the UI.
 *
 * Previously this data was duplicated three times with drift: the volunteer
 * form shipped 9/24 Tunisian and 7/22 Libyan entries, Moroccan region names
 * were truncated ("Maroc - Tanger-Tétouan" without "-Al Hoceïma"), the Arabic
 * name of L'Oriental diverged ("الشرق" vs "الشرقية"), several French fields
 * carried Arabic text (VolunteerRegistration built nameFr from the Arabic
 * wilaya name), and Libyan French spellings diverged (Az Zawiyah vs Zawiya,
 * Sebha vs Sabha). Every consumer now reads this module; the API
 * (/api/wilayas) remains the live source where available.
 *
 * Counts: Algeria 58 wilayas · Tunisia 24 · Morocco 12 regions · Libya 22.
 */
export interface MaghrebRegion {
  nameAr: string;
  nameFr: string;
  /** Fix 39 (Fix 29 follow-up): the machine-readable country — the phone
   * normalizer's country hint reads this, never the display-name prefix. */
  country: "DZ" | "TN" | "MA" | "LY";
}

export const MAGHREB_REGIONS: MaghrebRegion[] = [
  // الجزائر (58 ولاية)
  { nameAr: "الجزائر - أدرار", nameFr: "Algérie - Adrar", country: "DZ" },
  { nameAr: "الجزائر - الشلف", nameFr: "Algérie - Chlef", country: "DZ" },
  { nameAr: "الجزائر - الأغواط", nameFr: "Algérie - Laghouat", country: "DZ" },
  { nameAr: "الجزائر - أم البواقي", nameFr: "Algérie - Oum El Bouaghi", country: "DZ" },
  { nameAr: "الجزائر - باتنة", nameFr: "Algérie - Batna", country: "DZ" },
  { nameAr: "الجزائر - بجاية", nameFr: "Algérie - Béjaïa", country: "DZ" },
  { nameAr: "الجزائر - بسكرة", nameFr: "Algérie - Biskra", country: "DZ" },
  { nameAr: "الجزائر - بشار", nameFr: "Algérie - Béchar", country: "DZ" },
  { nameAr: "الجزائر - البليدة", nameFr: "Algérie - Blida", country: "DZ" },
  { nameAr: "الجزائر - البويرة", nameFr: "Algérie - Bouira", country: "DZ" },
  { nameAr: "الجزائر - تمنراست", nameFr: "Algérie - Tamanrasset", country: "DZ" },
  { nameAr: "الجزائر - تبسة", nameFr: "Algérie - Tébessa", country: "DZ" },
  { nameAr: "الجزائر - تلمسان", nameFr: "Algérie - Tlemcen", country: "DZ" },
  { nameAr: "الجزائر - تيارت", nameFr: "Algérie - Tiaret", country: "DZ" },
  { nameAr: "الجزائر - تيزي وزو", nameFr: "Algérie - Tizi Ouzou", country: "DZ" },
  { nameAr: "الجزائر - الجزائر العاصمة", nameFr: "Algérie - Alger", country: "DZ" },
  { nameAr: "الجزائر - الجلفة", nameFr: "Algérie - Djelfa", country: "DZ" },
  { nameAr: "الجزائر - جيجل", nameFr: "Algérie - Jijel", country: "DZ" },
  { nameAr: "الجزائر - سطيف", nameFr: "Algérie - Sétif", country: "DZ" },
  { nameAr: "الجزائر - سعيدة", nameFr: "Algérie - Saïda", country: "DZ" },
  { nameAr: "الجزائر - سكيكدة", nameFr: "Algérie - Skikda", country: "DZ" },
  { nameAr: "الجزائر - سيدي بلعباس", nameFr: "Algérie - Sidi Bel Abbès", country: "DZ" },
  { nameAr: "الجزائر - عنابة", nameFr: "Algérie - Annaba", country: "DZ" },
  { nameAr: "الجزائر - قالمة", nameFr: "Algérie - Guelma", country: "DZ" },
  { nameAr: "الجزائر - قسنطينة", nameFr: "Algérie - Constantine", country: "DZ" },
  { nameAr: "الجزائر - المدية", nameFr: "Algérie - Médéa", country: "DZ" },
  { nameAr: "الجزائر - مستغانم", nameFr: "Algérie - Mostaganem", country: "DZ" },
  { nameAr: "الجزائر - المسيلة", nameFr: "Algérie - M'Sila", country: "DZ" },
  { nameAr: "الجزائر - معسكر", nameFr: "Algérie - Mascara", country: "DZ" },
  { nameAr: "الجزائر - ورقلة", nameFr: "Algérie - Ouargla", country: "DZ" },
  { nameAr: "الجزائر - وهران", nameFr: "Algérie - Oran", country: "DZ" },
  { nameAr: "الجزائر - البيض", nameFr: "Algérie - El Bayadh", country: "DZ" },
  { nameAr: "الجزائر - إليزي", nameFr: "Algérie - Illizi", country: "DZ" },
  { nameAr: "الجزائر - برج بوعريريج", nameFr: "Algérie - Bordj Bou Arréridj", country: "DZ" },
  { nameAr: "الجزائر - بومرداس", nameFr: "Algérie - Boumerdès", country: "DZ" },
  { nameAr: "الجزائر - الطارف", nameFr: "Algérie - El Tarf", country: "DZ" },
  { nameAr: "الجزائر - تندوف", nameFr: "Algérie - Tindouf", country: "DZ" },
  { nameAr: "الجزائر - تيسمسيلت", nameFr: "Algérie - Tissemsilt", country: "DZ" },
  { nameAr: "الجزائر - الوادي", nameFr: "Algérie - El Oued", country: "DZ" },
  { nameAr: "الجزائر - خنشلة", nameFr: "Algérie - Khenchela", country: "DZ" },
  { nameAr: "الجزائر - سوق أهراس", nameFr: "Algérie - Souk Ahras", country: "DZ" },
  { nameAr: "الجزائر - تيبازة", nameFr: "Algérie - Tipaza", country: "DZ" },
  { nameAr: "الجزائر - ميلة", nameFr: "Algérie - Mila", country: "DZ" },
  { nameAr: "الجزائر - عين الدفلى", nameFr: "Algérie - Aïn Defla", country: "DZ" },
  { nameAr: "الجزائر - النعامة", nameFr: "Algérie - Naâma", country: "DZ" },
  { nameAr: "الجزائر - عين تموشنت", nameFr: "Algérie - Aïn Témouchent", country: "DZ" },
  { nameAr: "الجزائر - غرداية", nameFr: "Algérie - Ghardaïa", country: "DZ" },
  { nameAr: "الجزائر - غليزان", nameFr: "Algérie - Relizane", country: "DZ" },
  { nameAr: "الجزائر - تيميمون", nameFr: "Algérie - Timimoun", country: "DZ" },
  { nameAr: "الجزائر - برج باجي مختار", nameFr: "Algérie - Bordj Badji Mokhtar", country: "DZ" },
  { nameAr: "الجزائر - أولاد جلال", nameFr: "Algérie - Ouled Djellal", country: "DZ" },
  { nameAr: "الجزائر - بني عباس", nameFr: "Algérie - Béni Abbès", country: "DZ" },
  { nameAr: "الجزائر - عين صالح", nameFr: "Algérie - In Salah", country: "DZ" },
  { nameAr: "الجزائر - عين قزام", nameFr: "Algérie - In Guezzam", country: "DZ" },
  { nameAr: "الجزائر - تقرت", nameFr: "Algérie - Touggourt", country: "DZ" },
  { nameAr: "الجزائر - جانت", nameFr: "Algérie - Djanet", country: "DZ" },
  { nameAr: "الجزائر - المغير", nameFr: "Algérie - El M'Ghair", country: "DZ" },
  { nameAr: "الجزائر - المنيعة", nameFr: "Algérie - El Meniaa", country: "DZ" },

  // تونس (24 ولاية)
  { nameAr: "تونس - تونس العاصمة", nameFr: "Tunisie - Tunis", country: "TN" },
  { nameAr: "تونس - أريانة", nameFr: "Tunisie - Ariana", country: "TN" },
  { nameAr: "تونس - بن عروس", nameFr: "Tunisie - Ben Arous", country: "TN" },
  { nameAr: "تونس - منوبة", nameFr: "Tunisie - Manouba", country: "TN" },
  { nameAr: "تونس - نابل", nameFr: "Tunisie - Nabeul", country: "TN" },
  { nameAr: "تونس - زغوان", nameFr: "Tunisie - Zaghouan", country: "TN" },
  { nameAr: "تونس - بنزرت", nameFr: "Tunisie - Bizerte", country: "TN" },
  { nameAr: "تونس - باجة", nameFr: "Tunisie - Béja", country: "TN" },
  { nameAr: "تونس - جندوبة", nameFr: "Tunisie - Jendouba", country: "TN" },
  { nameAr: "تونس - الكاف", nameFr: "Tunisie - Le Kef", country: "TN" },
  { nameAr: "تونس - سليانة", nameFr: "Tunisie - Siliana", country: "TN" },
  { nameAr: "تونس - سوسة", nameFr: "Tunisie - Sousse", country: "TN" },
  { nameAr: "تونس - المنستير", nameFr: "Tunisie - Monastir", country: "TN" },
  { nameAr: "تونس - المهدية", nameFr: "Tunisie - Mahdia", country: "TN" },
  { nameAr: "تونس - صفاقس", nameFr: "Tunisie - Sfax", country: "TN" },
  { nameAr: "تونس - القيروان", nameFr: "Tunisie - Kairouan", country: "TN" },
  { nameAr: "تونس - القصرين", nameFr: "Tunisie - Kasserine", country: "TN" },
  { nameAr: "تونس - سيدي بوزيد", nameFr: "Tunisie - Sidi Bouzid", country: "TN" },
  { nameAr: "تونس - قابس", nameFr: "Tunisie - Gabès", country: "TN" },
  { nameAr: "تونس - مدنين", nameFr: "Tunisie - Medenine", country: "TN" },
  { nameAr: "تونس - تطاوين", nameFr: "Tunisie - Tataouine", country: "TN" },
  { nameAr: "تونس - قفصة", nameFr: "Tunisie - Gafsa", country: "TN" },
  { nameAr: "تونس - توزر", nameFr: "Tunisie - Tozeur", country: "TN" },
  { nameAr: "تونس - قبلي", nameFr: "Tunisie - Kebili", country: "TN" },

  // المغرب (12 جهة)
  { nameAr: "المغرب - طنجة تطوان الحسيمة", nameFr: "Maroc - Tanger-Tétouan-Al Hoceïma", country: "MA" },
  { nameAr: "المغرب - الشرقية", nameFr: "Maroc - L'Oriental", country: "MA" },
  { nameAr: "المغرب - فاس مكناس", nameFr: "Maroc - Fès-Meknès", country: "MA" },
  { nameAr: "المغرب - الرباط سلا القنيطرة", nameFr: "Maroc - Rabat-Salé-Kénitra", country: "MA" },
  { nameAr: "المغرب - بني ملال خنيفرة", nameFr: "Maroc - Béni Mellal-Khénifra", country: "MA" },
  { nameAr: "المغرب - الدار البيضاء سطات", nameFr: "Maroc - Casablanca-Settat", country: "MA" },
  { nameAr: "المغرب - مراكش آسفي", nameFr: "Maroc - Marrakech-Safi", country: "MA" },
  { nameAr: "المغرب - درعة تافيلالت", nameFr: "Maroc - Drâa-Tafilalet", country: "MA" },
  { nameAr: "المغرب - سوس ماسة", nameFr: "Maroc - Souss-Massa", country: "MA" },
  { nameAr: "المغرب - كلميم واد نون", nameFr: "Maroc - Guelmim-Oued Noun", country: "MA" },
  { nameAr: "المغرب - العيون الساقية الحمراء", nameFr: "Maroc - Laâyoune-Sakia El Hamra", country: "MA" },
  { nameAr: "المغرب - الداخلة وادي الذهب", nameFr: "Maroc - Dakhla-Oued Ed-Dahab", country: "MA" },

  // ليبيا (22 بلدية/شعبية)
  { nameAr: "ليبيا - طرابلس", nameFr: "Libye - Tripoli", country: "LY" },
  { nameAr: "ليبيا - بنغازي", nameFr: "Libye - Benghazi", country: "LY" },
  { nameAr: "ليبيا - مصراتة", nameFr: "Libye - Misrata", country: "LY" },
  { nameAr: "ليبيا - الزاوية", nameFr: "Libye - Zawiya", country: "LY" },
  { nameAr: "ليبيا - سبها", nameFr: "Libye - Sabha", country: "LY" },
  { nameAr: "ليبيا - سرت", nameFr: "Libye - Sirte", country: "LY" },
  { nameAr: "ليبيا - طبرق", nameFr: "Libye - Tobruk", country: "LY" },
  { nameAr: "ليبيا - درنة", nameFr: "Libye - Derna", country: "LY" },
  { nameAr: "ليبيا - الجبل الأخضر", nameFr: "Libye - Al Jabal al Akhdar", country: "LY" },
  { nameAr: "ليبيا - المرج", nameFr: "Libye - Al Marj", country: "LY" },
  { nameAr: "ليبيا - الواحات", nameFr: "Libye - Al Wahat", country: "LY" },
  { nameAr: "ليبيا - الكفرة", nameFr: "Libye - Al Kufra", country: "LY" },
  { nameAr: "ليبيا - مرزق", nameFr: "Libye - Murzuq", country: "LY" },
  { nameAr: "ليبيا - غات", nameFr: "Libye - Ghat", country: "LY" },
  { nameAr: "ليبيا - وادي الحياة", nameFr: "Libye - Wadi al Hayaa", country: "LY" },
  { nameAr: "ليبيا - وادي الشاطئ", nameFr: "Libye - Wadi al Shatii", country: "LY" },
  { nameAr: "ليبيا - الجفرة", nameFr: "Libye - Al Jufra", country: "LY" },
  { nameAr: "ليبيا - الجبل الغربي", nameFr: "Libye - Jabal al Gharbi", country: "LY" },
  { nameAr: "ليبيا - نالوت", nameFr: "Libye - Nalut", country: "LY" },
  { nameAr: "ليبيا - النقاط الخمس", nameFr: "Libye - Nuqat al Khams", country: "LY" },
  { nameAr: "ليبيا - الجفارة", nameFr: "Libye - Al Jfara", country: "LY" },
  { nameAr: "ليبيا - المرقب", nameFr: "Libye - Al Murgub", country: "LY" },
];

/** Curated northeast-Algeria focus wilayas for the AI copilot quick filter
    (the observatory's initial coverage area). Short names, no country prefix. */
export const NORTHEAST_ALGERIA_FOCUS: { code: string; ar: string; fr: string }[] = [
  // code = the official wilaya number: the stable identity for selection.
  // Display text (ar/fr) must never be identity — a language switch or a
  // rewording would silently unselect the wilaya (Fix 30, AI-2).
  { code: "36", ar: "الطارف", fr: "El Tarf" },
  { code: "21", ar: "سكيكدة", fr: "Skikda" },
  { code: "23", ar: "عنابة", fr: "Annaba" },
  { code: "41", ar: "سوق أهراس", fr: "Souk Ahras" },
  { code: "18", ar: "جيجل", fr: "Jijel" },
  { code: "24", ar: "قالمة", fr: "Guelma" },
];
