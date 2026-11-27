package com.observatory.wildfire

/** A place field belongs to one captured fix, including across async lookups. */
object ReportPlacePolicy {
    fun sameCoordinates(bound: LocationLogic.FixSnapshot?, fix: LocationLogic.FixSnapshot): Boolean =
        bound == null || (bound.lat == fix.lat && bound.lng == fix.lng)

    fun canApplyRecovery(
        bound: LocationLogic.FixSnapshot?, fix: LocationLogic.FixSnapshot,
        nameManuallyEdited: Boolean, wilayaManuallyEdited: Boolean
    ): Boolean = sameCoordinates(bound, fix) || (!nameManuallyEdited && !wilayaManuallyEdited)

    fun canFillOfflineWilaya(
        bound: LocationLogic.FixSnapshot?, fix: LocationLogic.FixSnapshot,
        autofilledName: Boolean, nameManuallyEdited: Boolean, wilayaManuallyEdited: Boolean
    ): Boolean = sameCoordinates(bound, fix) ||
        (!autofilledName && !nameManuallyEdited && !wilayaManuallyEdited)
}
