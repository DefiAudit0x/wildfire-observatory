package com.observatory.wildfire

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min

/**
 * v2.19.0 — the 69 wilayas of Algeria (codes 1-69, official + delegated)
 * with Arabic/Latin names and the wilaya-seat centroid.
 *
 * Source: MIT-licensed dataset cross-checked between chemsallioua/Algeria69WilayaMap
 * (names) and MoussaabBadla/algeria-fire-map wilayas.json (geo-referenced centroids).
 *
 * v2.19.0 correction: wilaya 11's centroid came from the upstream dataset as
 * an area centroid ~250 km west of the actual seat — replaced with the real
 * Tamanrasset city coordinates (a field user there must read تمنراست).
 *
 * Used by the radar awareness line, the map status line, and the report form's
 * OFFLINE fallback (nearest-wilaya by cos-corrected squared-degree distance —
 * the same nearest-centroid technique the algeria-fire-map web app uses).
 */
object Wilayas {

    data class Wilaya(val code: Int, val nameAr: String, val nameLatin: String, val lat: Double, val lng: Double)

    val ALL: List<Wilaya> = listOf(
        Wilaya(1, "أدرار", "Adrar", 27.867, -0.283),
        Wilaya(2, "الشلف", "Chlef", 36.16472, 1.33167),
        Wilaya(3, "الأغواط", "Laghouat", 33.80278, 2.875),
        Wilaya(4, "أم البواقي", "Oum El Bouaghi", 35.8775, 7.11361),
        Wilaya(5, "باتنة", "Batna", 35.55, 6.16667),
        Wilaya(6, "بجاية", "Béjaïa", 36.75111, 5.06417),
        Wilaya(7, "بسكرة", "Biskra", 34.85, 5.733),
        Wilaya(8, "بشار", "Béchar", 31.617, -2.217),
        Wilaya(9, "البليدة", "Blida", 36.46861, 2.83194),
        Wilaya(10, "البويرة", "Bouira", 36.38, 3.90139),
        Wilaya(11, "تمنراست", "Tamanrasset", 22.785, 8.1397),
        Wilaya(12, "تبسة", "Tébessa", 35.4, 8.117),
        Wilaya(13, "تلمسان", "Tlemcen", 34.88278, -1.31667),
        Wilaya(14, "تيارت", "Tiaret", 35.367, 1.317),
        Wilaya(15, "تيزي وزو", "Tizi Ouzou", 36.717, 4.05),
        Wilaya(16, "الجزائر", "Alger", 36.7325, 3.08722),
        Wilaya(17, "الجلفة", "Djelfa", 34.66667, 3.25),
        Wilaya(18, "جيجل", "Jijel", 36.81667, 5.75),
        Wilaya(19, "سطيف", "Sétif", 36.19, 5.41),
        Wilaya(20, "سعيدة", "Saïda", 34.833, 0.15),
        Wilaya(21, "سكيكدة", "Skikda", 36.86667, 6.9),
        Wilaya(22, "سيدي بلعباس", "Sidi Bel Abbès", 35.19389, -0.64139),
        Wilaya(23, "عنابة", "Annaba", 36.9, 7.767),
        Wilaya(24, "قالمة", "Guelma", 36.45, 7.433),
        Wilaya(25, "قسنطينة", "Constantine", 36.35, 6.6),
        Wilaya(26, "المدية", "Médéa", 36.2675, 2.75),
        Wilaya(27, "مستغانم", "Mostaganem", 35.933, 0.083),
        Wilaya(28, "المسيلة", "M'sila", 35.70194, 4.54722),
        Wilaya(29, "معسكر", "Mascara", 35.4, 0.13333),
        Wilaya(30, "ورقلة", "Ouargla", 31.95, 5.317),
        Wilaya(31, "وهران", "Oran", 35.69694, -0.63306),
        Wilaya(32, "البيض", "El Bayadh", 33.68028, 1.02028),
        Wilaya(33, "إليزي", "Illizi", 26.505, 8.482),
        Wilaya(34, "برج بوعريريج", "Bordj Bou Arreridj", 36.067, 4.767),
        Wilaya(35, "بومرداس", "Boumerdès", 36.76034, 3.47236),
        Wilaya(36, "الطارف", "El Tarf", 36.767, 8.317),
        Wilaya(37, "تندوف", "Tindouf", 27.67528, -8.12861),
        Wilaya(38, "تيسمسيلت", "Tissemsilt", 35.60778, 1.81111),
        Wilaya(39, "الوادي", "El Oued", 33.36111, 6.86056),
        Wilaya(40, "خنشلة", "Khenchela", 35.417, 7.133),
        Wilaya(41, "سوق أهراس", "Souk Ahras", 36.28639, 7.95111),
        Wilaya(42, "تيبازة", "Tipaza", 36.59194, 2.44944),
        Wilaya(43, "ميلة", "Mila", 36.45, 6.27),
        Wilaya(44, "عين الدفلى", "Aïn Defla", 36.2652, 1.9703),
        Wilaya(45, "النعامة", "Naâma", 33.26222, -0.31444),
        Wilaya(46, "عين تموشنت", "Aïn Témouchent", 35.3, -1.133),
        Wilaya(47, "غرداية", "Ghardaïa", 32.483, 3.667),
        Wilaya(48, "غليزان", "Relizane", 35.73333, 0.55),
        Wilaya(49, "تيميمون", "Timimoun", 29.2605, 0.2286),
        Wilaya(50, "برج باجي مختار", "Bordj Badji Mokhtar", 21.32889, 0.95417),
        Wilaya(51, "أولاد جلال", "Ouled Djellal", 34.417, 5.067),
        Wilaya(52, "بني عباس", "Béni Abbès", 30.08, -2.1),
        Wilaya(53, "عين صالح", "In Salah", 27.195, 2.48333),
        Wilaya(54, "عين قزام", "In Guezzam", 19.56861, 5.77222),
        Wilaya(55, "توقرت", "Touggourt", 33.1, 6.067),
        Wilaya(56, "جانت", "Djanet", 24.555, 9.48528),
        Wilaya(57, "المغير", "El M'Ghair", 33.95056, 5.92417),
        Wilaya(58, "المنيعة", "El Meniaa", 30.583, 2.883),
        Wilaya(59, "آفلو", "Aflou", 34.10889, 2.10194),
        Wilaya(60, "بريكة", "Barika", 35.3848, 5.3607),
        Wilaya(61, "القنطرة", "El Kantara", 35.2231, 5.7093),
        Wilaya(62, "بئر العاتر", "Bir El Ater", 34.74861, 8.05806),
        Wilaya(63, "العريشة", "El Aricha", 34.224, -1.2577),
        Wilaya(64, "قصر الشلالة", "Ksar Chellala", 35.2143, 2.3129),
        Wilaya(65, "عين وسارة", "Aïn Oussera", 35.4487, 2.9073),
        Wilaya(66, "مسعد", "Messaad", 34.1541, 3.4922),
        Wilaya(67, "قصر البخاري", "Ksar El Boukhari", 35.8863, 2.7502),
        Wilaya(68, "بوسعادة", "Bou Saâda", 35.2133, 4.181),
        Wilaya(69, "الأبيض سيدي الشيخ", "El Abiodh Sidi Cheikh", 32.8965, 0.5464),
    )

    private val BY_NAME_AR: Map<String, Wilaya> = ALL.associateBy { it.nameAr }

    /**
     * Nearest wilaya to a coordinate, by cos(lat)-corrected squared-degree
     * distance (a longitude degree shrinks with latitude — the correction keeps
     * the ranking honest in the north AND the deep south, with no trig per row
     * beyond the single cos). Pure and unit-tested.
     */
    fun nearest(lat: Double, lng: Double): Wilaya {
        val cosLat = cos(lat * PI / 180.0)
        var best = ALL[0]
        var bestD = Double.MAX_VALUE
        for (w in ALL) {
            val dLat = lat - w.lat
            val dLng = (lng - w.lng) * cosLat
            val d = dLat * dLat + dLng * dLng
            if (d < bestD) { bestD = d; best = w }
        }
        return best
    }

    fun byNameAr(name: String): Wilaya? = BY_NAME_AR[name]
}
