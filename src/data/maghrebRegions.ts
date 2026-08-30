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
}

export const MAGHREB_REGIONS: MaghrebRegion[] = [
  // الجزائر (58 ولاية)
  { nameAr: "الجزائر - أدرار", nameFr: "Algérie - Adrar" },
  { nameAr: "الجزائر - الشلف", nameFr: "Algérie - Chlef" },
  { nameAr: "الجزائر - الأغواط", nameFr: "Algérie - Laghouat" },
  { nameAr: "الجزائر - أم البواقي", nameFr: "Algérie - Oum El Bouaghi" },
  { nameAr: "الجزائر - باتنة", nameFr: "Algérie - Batna" },
  { nameAr: "الجزائر - بجاية", nameFr: "Algérie - Béjaïa" },
  { nameAr: "الجزائر - بسكرة", nameFr: "Algérie - Biskra" },
  { nameAr: "الجزائر - بشار", nameFr: "Algérie - Béchar" },
  { nameAr: "الجزائر - البليدة", nameFr: "Algérie - Blida" },
  { nameAr: "الجزائر - البويرة", nameFr: "Algérie - Bouira" },
  { nameAr: "الجزائر - تمنراست", nameFr: "Algérie - Tamanrasset" },
  { nameAr: "الجزائر - تبسة", nameFr: "Algérie - Tébessa" },
  { nameAr: "الجزائر - تلمسان", nameFr: "Algérie - Tlemcen" },
  { nameAr: "الجزائر - تيارت", nameFr: "Algérie - Tiaret" },
  { nameAr: "الجزائر - تيزي وزو", nameFr: "Algérie - Tizi Ouzou" },
  { nameAr: "الجزائر - الجزائر العاصمة", nameFr: "Algérie - Alger" },
  { nameAr: "الجزائر - الجلفة", nameFr: "Algérie - Djelfa" },
  { nameAr: "الجزائر - جيجل", nameFr: "Algérie - Jijel" },
  { nameAr: "الجزائر - سطيف", nameFr: "Algérie - Sétif" },
  { nameAr: "الجزائر - سعيدة", nameFr: "Algérie - Saïda" },
  { nameAr: "الجزائر - سكيكدة", nameFr: "Algérie - Skikda" },
  { nameAr: "الجزائر - سيدي بلعباس", nameFr: "Algérie - Sidi Bel Abbès" },
  { nameAr: "الجزائر - عنابة", nameFr: "Algérie - Annaba" },
  { nameAr: "الجزائر - قالمة", nameFr: "Algérie - Guelma" },
  { nameAr: "الجزائر - قسنطينة", nameFr: "Algérie - Constantine" },
  { nameAr: "الجزائر - المدية", nameFr: "Algérie - Médéa" },
  { nameAr: "الجزائر - مستغانم", nameFr: "Algérie - Mostaganem" },
  { nameAr: "الجزائر - المسيلة", nameFr: "Algérie - M'Sila" },
  { nameAr: "الجزائر - معسكر", nameFr: "Algérie - Mascara" },
  { nameAr: "الجزائر - ورقلة", nameFr: "Algérie - Ouargla" },
  { nameAr: "الجزائر - وهران", nameFr: "Algérie - Oran" },
  { nameAr: "الجزائر - البيض", nameFr: "Algérie - El Bayadh" },
  { nameAr: "الجزائر - إليزي", nameFr: "Algérie - Illizi" },
  { nameAr: "الجزائر - برج بوعريريج", nameFr: "Algérie - Bordj Bou Arréridj" },
  { nameAr: "الجزائر - بومرداس", nameFr: "Algérie - Boumerdès" },
  { nameAr: "الجزائر - الطارف", nameFr: "Algérie - El Tarf" },
  { nameAr: "الجزائر - تندوف", nameFr: "Algérie - Tindouf" },
  { nameAr: "الجزائر - تيسمسيلت", nameFr: "Algérie - Tissemsilt" },
  { nameAr: "الجزائر - الوادي", nameFr: "Algérie - El Oued" },
  { nameAr: "الجزائر - خنشلة", nameFr: "Algérie - Khenchela" },
  { nameAr: "الجزائر - سوق أهراس", nameFr: "Algérie - Souk Ahras" },
  { nameAr: "الجزائر - تيبازة", nameFr: "Algérie - Tipaza" },
  { nameAr: "الجزائر - ميلة", nameFr: "Algérie - Mila" },
  { nameAr: "الجزائر - عين الدفلى", nameFr: "Algérie - Aïn Defla" },
  { nameAr: "الجزائر - النعامة", nameFr: "Algérie - Naâma" },
  { nameAr: "الجزائر - عين تموشنت", nameFr: "Algérie - Aïn Témouchent" },
  { nameAr: "الجزائر - غرداية", nameFr: "Algérie - Ghardaïa" },
  { nameAr: "الجزائر - غليزان", nameFr: "Algérie - Relizane" },
  { nameAr: "الجزائر - تيميمون", nameFr: "Algérie - Timimoun" },
  { nameAr: "الجزائر - برج باجي مختار", nameFr: "Algérie - Bordj Badji Mokhtar" },
  { nameAr: "الجزائر - أولاد جلال", nameFr: "Algérie - Ouled Djellal" },
  { nameAr: "الجزائر - بني عباس", nameFr: "Algérie - Béni Abbès" },
  { nameAr: "الجزائر - عين صالح", nameFr: "Algérie - In Salah" },
  { nameAr: "الجزائر - عين قزام", nameFr: "Algérie - In Guezzam" },
  { nameAr: "الجزائر - تقرت", nameFr: "Algérie - Touggourt" },
  { nameAr: "الجزائر - جانت", nameFr: "Algérie - Djanet" },
  { nameAr: "الجزائر - المغير", nameFr: "Algérie - El M'Ghair" },
  { nameAr: "الجزائر - المنيعة", nameFr: "Algérie - El Meniaa" },

  // تونس (24 ولاية)
  { nameAr: "تونس - تونس العاصمة", nameFr: "Tunisie - Tunis" },
  { nameAr: "تونس - أريانة", nameFr: "Tunisie - Ariana" },
  { nameAr: "تونس - بن عروس", nameFr: "Tunisie - Ben Arous" },
  { nameAr: "تونس - منوبة", nameFr: "Tunisie - Manouba" },
  { nameAr: "تونس - نابل", nameFr: "Tunisie - Nabeul" },
  { nameAr: "تونس - زغوان", nameFr: "Tunisie - Zaghouan" },
  { nameAr: "تونس - بنزرت", nameFr: "Tunisie - Bizerte" },
  { nameAr: "تونس - باجة", nameFr: "Tunisie - Béja" },
  { nameAr: "تونس - جندوبة", nameFr: "Tunisie - Jendouba" },
  { nameAr: "تونس - الكاف", nameFr: "Tunisie - Le Kef" },
  { nameAr: "تونس - سليانة", nameFr: "Tunisie - Siliana" },
  { nameAr: "تونس - سوسة", nameFr: "Tunisie - Sousse" },
  { nameAr: "تونس - المنستير", nameFr: "Tunisie - Monastir" },
  { nameAr: "تونس - المهدية", nameFr: "Tunisie - Mahdia" },
  { nameAr: "تونس - صفاقس", nameFr: "Tunisie - Sfax" },
  { nameAr: "تونس - القيروان", nameFr: "Tunisie - Kairouan" },
  { nameAr: "تونس - القصرين", nameFr: "Tunisie - Kasserine" },
  { nameAr: "تونس - سيدي بوزيد", nameFr: "Tunisie - Sidi Bouzid" },
  { nameAr: "تونس - قابس", nameFr: "Tunisie - Gabès" },
  { nameAr: "تونس - مدنين", nameFr: "Tunisie - Medenine" },
  { nameAr: "تونس - تطاوين", nameFr: "Tunisie - Tataouine" },
  { nameAr: "تونس - قفصة", nameFr: "Tunisie - Gafsa" },
  { nameAr: "تونس - توزر", nameFr: "Tunisie - Tozeur" },
  { nameAr: "تونس - قبلي", nameFr: "Tunisie - Kebili" },

  // المغرب (12 جهة)
  { nameAr: "المغرب - طنجة تطوان الحسيمة", nameFr: "Maroc - Tanger-Tétouan-Al Hoceïma" },
  { nameAr: "المغرب - الشرقية", nameFr: "Maroc - L'Oriental" },
  { nameAr: "المغرب - فاس مكناس", nameFr: "Maroc - Fès-Meknès" },
  { nameAr: "المغرب - الرباط سلا القنيطرة", nameFr: "Maroc - Rabat-Salé-Kénitra" },
  { nameAr: "المغرب - بني ملال خنيفرة", nameFr: "Maroc - Béni Mellal-Khénifra" },
  { nameAr: "المغرب - الدار البيضاء سطات", nameFr: "Maroc - Casablanca-Settat" },
  { nameAr: "المغرب - مراكش آسفي", nameFr: "Maroc - Marrakech-Safi" },
  { nameAr: "المغرب - درعة تافيلالت", nameFr: "Maroc - Drâa-Tafilalet" },
  { nameAr: "المغرب - سوس ماسة", nameFr: "Maroc - Souss-Massa" },
  { nameAr: "المغرب - كلميم واد نون", nameFr: "Maroc - Guelmim-Oued Noun" },
  { nameAr: "المغرب - العيون الساقية الحمراء", nameFr: "Maroc - Laâyoune-Sakia El Hamra" },
  { nameAr: "المغرب - الداخلة وادي الذهب", nameFr: "Maroc - Dakhla-Oued Ed-Dahab" },

  // ليبيا (22 بلدية/شعبية)
  { nameAr: "ليبيا - طرابلس", nameFr: "Libye - Tripoli" },
  { nameAr: "ليبيا - بنغازي", nameFr: "Libye - Benghazi" },
  { nameAr: "ليبيا - مصراتة", nameFr: "Libye - Misrata" },
  { nameAr: "ليبيا - الزاوية", nameFr: "Libye - Zawiya" },
  { nameAr: "ليبيا - سبها", nameFr: "Libye - Sabha" },
  { nameAr: "ليبيا - سرت", nameFr: "Libye - Sirte" },
  { nameAr: "ليبيا - طبرق", nameFr: "Libye - Tobruk" },
  { nameAr: "ليبيا - درنة", nameFr: "Libye - Derna" },
  { nameAr: "ليبيا - الجبل الأخضر", nameFr: "Libye - Al Jabal al Akhdar" },
  { nameAr: "ليبيا - المرج", nameFr: "Libye - Al Marj" },
  { nameAr: "ليبيا - الواحات", nameFr: "Libye - Al Wahat" },
  { nameAr: "ليبيا - الكفرة", nameFr: "Libye - Al Kufra" },
  { nameAr: "ليبيا - مرزق", nameFr: "Libye - Murzuq" },
  { nameAr: "ليبيا - غات", nameFr: "Libye - Ghat" },
  { nameAr: "ليبيا - وادي الحياة", nameFr: "Libye - Wadi al Hayaa" },
  { nameAr: "ليبيا - وادي الشاطئ", nameFr: "Libye - Wadi al Shatii" },
  { nameAr: "ليبيا - الجفرة", nameFr: "Libye - Al Jufra" },
  { nameAr: "ليبيا - الجبل الغربي", nameFr: "Libye - Jabal al Gharbi" },
  { nameAr: "ليبيا - نالوت", nameFr: "Libye - Nalut" },
  { nameAr: "ليبيا - النقاط الخمس", nameFr: "Libye - Nuqat al Khams" },
  { nameAr: "ليبيا - الجفارة", nameFr: "Libye - Al Jfara" },
  { nameAr: "ليبيا - المرقب", nameFr: "Libye - Al Murgub" },
];

/** Curated northeast-Algeria focus wilayas for the AI copilot quick filter
    (the observatory's initial coverage area). Short names, no country prefix. */
export const NORTHEAST_ALGERIA_FOCUS: { ar: string; fr: string }[] = [
  { ar: "الطارف", fr: "El Tarf" },
  { ar: "سكيكدة", fr: "Skikda" },
  { ar: "عنابة", fr: "Annaba" },
  { ar: "سوق أهراس", fr: "Souk Ahras" },
  { ar: "جيجل", fr: "Jijel" },
  { ar: "قالمة", fr: "Guelma" },
];
