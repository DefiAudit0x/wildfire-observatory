package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2.19.0 — the 69-wilaya table pins. The radar awareness line, the map
 * status line and the report's offline fallback all trust this table: a
 * wrong count or a mis-mapped north-coast point lies to a field user.
 */
class WilayasTest {

    // Documented centroids, copied verbatim from Wilayas.kt at base
    // 9f43f12. Literals on purpose: reading them from the table would
    // make the tests follow any drift instead of catching it.
    private val EXPECTED_CENTROIDS = listOf(
        Triple(1, 27.867, -0.283),
        Triple(2, 36.16472, 1.33167),
        Triple(3, 33.80278, 2.875),
        Triple(4, 35.8775, 7.11361),
        Triple(5, 35.55, 6.16667),
        Triple(6, 36.75111, 5.06417),
        Triple(7, 34.85, 5.733),
        Triple(8, 31.617, -2.217),
        Triple(9, 36.46861, 2.83194),
        Triple(10, 36.38, 3.90139),
        Triple(11, 22.785, 8.1397),
        Triple(12, 35.4, 8.117),
        Triple(13, 34.88278, -1.31667),
        Triple(14, 35.367, 1.317),
        Triple(15, 36.717, 4.05),
        Triple(16, 36.7325, 3.08722),
        Triple(17, 34.66667, 3.25),
        Triple(18, 36.81667, 5.75),
        Triple(19, 36.19, 5.41),
        Triple(20, 34.833, 0.15),
        Triple(21, 36.86667, 6.9),
        Triple(22, 35.19389, -0.64139),
        Triple(23, 36.9, 7.767),
        Triple(24, 36.45, 7.433),
        Triple(25, 36.35, 6.6),
        Triple(26, 36.2675, 2.75),
        Triple(27, 35.933, 0.083),
        Triple(28, 35.70194, 4.54722),
        Triple(29, 35.4, 0.13333),
        Triple(30, 31.95, 5.317),
        Triple(31, 35.69694, -0.63306),
        Triple(32, 33.68028, 1.02028),
        Triple(33, 26.505, 8.482),
        Triple(34, 36.067, 4.767),
        Triple(35, 36.76034, 3.47236),
        Triple(36, 36.767, 8.317),
        Triple(37, 27.67528, -8.12861),
        Triple(38, 35.60778, 1.81111),
        Triple(39, 33.36111, 6.86056),
        Triple(40, 35.417, 7.133),
        Triple(41, 36.28639, 7.95111),
        Triple(42, 36.59194, 2.44944),
        Triple(43, 36.45, 6.27),
        Triple(44, 36.2652, 1.9703),
        Triple(45, 33.26222, -0.31444),
        Triple(46, 35.3, -1.133),
        Triple(47, 32.483, 3.667),
        Triple(48, 35.73333, 0.55),
        Triple(49, 29.2605, 0.2286),
        Triple(50, 21.32889, 0.95417),
        Triple(51, 34.417, 5.067),
        Triple(52, 30.08, -2.1),
        Triple(53, 27.195, 2.48333),
        Triple(54, 19.56861, 5.77222),
        Triple(55, 33.1, 6.067),
        Triple(56, 24.555, 9.48528),
        Triple(57, 33.95056, 5.92417),
        Triple(58, 30.583, 2.883),
        Triple(59, 34.10889, 2.10194),
        Triple(60, 35.3848, 5.3607),
        Triple(61, 35.2231, 5.7093),
        Triple(62, 34.74861, 8.05806),
        Triple(63, 34.224, -1.2577),
        Triple(64, 35.2143, 2.3129),
        Triple(65, 35.4487, 2.9073),
        Triple(66, 34.1541, 3.4922),
        Triple(67, 35.8863, 2.7502),
        Triple(68, 35.2133, 4.181),
        Triple(69, 32.8965, 0.5464)
    )

    @Test
    fun `exactly 69 wilayas with unique codes 1 to 69`() {
        assertEquals(69, Wilayas.ALL.size)
        assertEquals((1..69).toList(), Wilayas.ALL.map { it.code })
    }

    @Test
    fun `every wilaya carries both names and a sane algeria coordinate`() {
        for (w in Wilayas.ALL) {
            assertTrue("arabic name ${w.code}", w.nameAr.isNotBlank())
            assertTrue("latin name ${w.code}", w.nameLatin.isNotBlank())
            // Algeria's bounding box (with a small tolerance for the table's
            // rounded centroids).
            assertTrue("lat ${w.code}", w.lat in 18.5..37.5)
            assertTrue("lng ${w.code}", w.lng in -9.0..12.5)
        }
    }

    @Test
    fun `every centroid matches its documented coordinates`() {
        for ((code, lat, lng) in EXPECTED_CENTROIDS) {
            val w = Wilayas.ALL.first { it.code == code }
            assertEquals("lat $code", lat, w.lat, 0.0)
            assertEquals("lng $code", lng, w.lng, 0.0)
        }
    }

    @Test
    fun `every centroid resolves to its own wilaya`() {
        for ((code, lat, lng) in EXPECTED_CENTROIDS) {
            assertEquals("nearest $code", code, Wilayas.nearest(lat, lng).code)
        }
    }

    @Test
    fun `algiers point resolves to algiers`() {
        // Central Algiers (36.7538, 3.0588 — the map's cold-start center).
        assertEquals(16, Wilayas.nearest(36.7538, 3.0588).code)
    }

    @Test
    fun `tizi ouzou and oran resolve to their own seats`() {
        assertEquals(15, Wilayas.nearest(36.7169, 4.0497).code)  // Tizi Ouzou
        assertEquals(31, Wilayas.nearest(35.6971, -0.6308).code) // Oran
    }

    @Test
    fun `deep south resolves to a saharan wilaya not a coastal one`() {
        // Tamanrasset city — cos-correction must keep it there, not pull it
        // toward a closer-lng northern centroid at equal raw degree distance.
        val w = Wilayas.nearest(22.785, 8.1397)
        assertEquals(11, w.code)
    }

    @Test
    fun `byNameAr round-trips the table`() {
        val tizi = Wilayas.ALL.first { it.code == 15 }
        assertEquals(tizi.code, Wilayas.byNameAr(tizi.nameAr)?.code)
        assertNotNull(Wilayas.byNameAr("أدرار"))
    }
}
