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
