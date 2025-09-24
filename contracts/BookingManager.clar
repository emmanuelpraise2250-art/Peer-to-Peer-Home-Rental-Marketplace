(define-constant ERR-NOT-AUTHORIZED u200)
(define-constant ERR-INVALID-PROPERTY u201)
(define-constant ERR-INVALID-DATES u202)
(define-constant ERR-INVALID-COST u203)
(define-constant ERR-INVALID-STATUS u204)
(define-constant ERR-BOOKING-EXISTS u205)
(define-constant ERR-BOOKING-NOT-FOUND u206)
(define-constant ERR-PROPERTY-NOT-AVAILABLE u207)
(define-constant ERR-HOST-NOT-VERIFIED u208)
(define-constant ERR-ESCROW-FAIL u209)
(define-constant ERR-INVALID-GUEST u210)
(define-constant ERR-INVALID-HOST u211)
(define-constant ERR-INVALID-START-DATE u212)
(define-constant ERR-INVALID-END-DATE u213)
(define-constant ERR-INVALID-CANCELLATION-FEE u214)
(define-constant ERR-INVALID-DEPOSIT u215)
(define-constant ERR-MAX-BOOKINGS-EXCEEDED u216)
(define-constant ERR-INVALID-UPDATE-PARAM u217)
(define-constant ERR-UPDATE-NOT-ALLOWED u218)
(define-constant ERR-INVALID-REVIEW-RATING u219)
(define-constant ERR-INVALID-REVIEW-COMMENT u220)

(define-data-var next-booking-id uint u1)
(define-data-var max-bookings uint u10000)
(define-data-var platform-fee-rate uint u5)
(define-data-var cancellation-fee-rate uint u10)

(define-map bookings
  { booking-id: uint }
  {
    property-id: uint,
    host: principal,
    guest: principal,
    start-date: uint,
    end-date: uint,
    total-cost: uint,
    deposit: uint,
    status: (string-ascii 20),
    escrow-id: uint,
    timestamp: uint,
    cancellation-fee: uint,
    review-rating: (optional uint),
    review-comment: (optional (string-utf8 500))
  }
)

(define-map bookings-by-property
  { property-id: uint }
  (list 100 uint)
)

(define-map booking-updates
  { booking-id: uint }
  {
    update-status: (string-ascii 20),
    update-timestamp: uint,
    updater: principal
  }
)

(define-read-only (get-booking (id uint))
  (map-get? bookings { booking-id: id })
)

(define-read-only (get-booking-updates (id uint))
  (map-get? booking-updates { booking-id: id })
)

(define-read-only (get-bookings-for-property (property-id uint))
  (map-get? bookings-by-property { property-id: property-id })
)

(define-private (validate-dates (start uint) (end uint))
  (if (and (> start block-height) (> end start))
      (ok true)
      (err ERR-INVALID-DATES))
)

(define-private (validate-cost (cost uint))
  (if (> cost u0)
      (ok true)
      (err ERR-INVALID-COST))
)

(define-private (validate-status (status (string-ascii 20)))
  (if (or (is-eq status "pending") (is-eq status "confirmed") (is-eq status "cancelled") (is-eq status "completed"))
      (ok true)
      (err ERR-INVALID-STATUS))
)

(define-private (validate-deposit (deposit uint) (total uint))
  (if (and (>= deposit u0) (<= deposit total))
      (ok true)
      (err ERR-INVALID-DEPOSIT))
)

(define-private (validate-cancellation-fee (fee uint) (total uint))
  (if (<= fee total)
      (ok true)
      (err ERR-INVALID-CANCELLATION-FEE))
)

(define-private (validate-review-rating (rating uint))
  (if (and (>= rating u1) (<= rating u5))
      (ok true)
      (err ERR-INVALID-REVIEW-RATING))
)

(define-private (validate-review-comment (comment (string-utf8 500)))
  (if (<= (len comment) u500)
      (ok true)
      (err ERR-INVALID-REVIEW-COMMENT))
)

(define-private (is-property-available (property-id uint) (start uint) (end uint))
  (let ((existing-bookings (default-to (list) (get-bookings-for-property property-id))))
    (fold check-overlap existing-bookings true)
  )
)

(define-private (check-overlap (booking-id uint) (available bool))
  (if (not available) false
    (let ((booking (unwrap-panic (get-booking booking-id))))
      (if (or (is-eq (get status booking) "cancelled") (>= start (get end-date booking)) (<= end (get start-date booking)))
          true
          false
      )
    )
  )
)

(define-public (set-max-bookings (new-max uint))
  (begin
    (asserts! (is-eq tx-sender contract-caller) (err ERR-NOT-AUTHORIZED))
    (var-set max-bookings new-max)
    (ok true)
  )
)

(define-public (set-platform-fee-rate (new-rate uint))
  (begin
    (asserts! (is-eq tx-sender contract-caller) (err ERR-NOT-AUTHORIZED))
    (asserts! (<= new-rate u20) (err ERR-INVALID-UPDATE-PARAM))
    (var-set platform-fee-rate new-rate)
    (ok true)
  )
)

(define-public (set-cancellation-fee-rate (new-rate uint))
  (begin
    (asserts! (is-eq tx-sender contract-caller) (err ERR-NOT-AUTHORIZED))
    (asserts! (<= new-rate u50) (err ERR-INVALID-UPDATE-PARAM))
    (var-set cancellation-fee-rate new-rate)
    (ok true)
  )
)

(define-public (create-booking (property-id uint) (start-date uint) (end-date uint) (total-cost uint) (deposit uint))
  (let ((guest tx-sender)
        (booking-id (var-get next-booking-id))
        (property (unwrap! (contract-call? .PropertyRegistry get-property property-id) (err ERR-INVALID-PROPERTY)))
        (host (get owner property)))
    (try! (validate-dates start-date end-date))
    (try! (validate-cost total-cost))
    (try! (validate-deposit deposit total-cost))
    (let ((identity (unwrap! (contract-call? .IdentityRegistry get-identity host) (err ERR-HOST-NOT-VERIFIED))))
      (asserts! (get verified identity) (err ERR-HOST-NOT-VERIFIED))
    )
    (asserts! (is-property-available property-id start-date end-date) (err ERR-PROPERTY-NOT-AVAILABLE))
    (let ((escrow-id (unwrap! (contract-call? .Escrow create-escrow guest host total-cost deposit) (err ERR-ESCROW-FAIL))))
      (map-set bookings { booking-id: booking-id }
        {
          property-id: property-id,
          host: host,
          guest: guest,
          start-date: start-date,
          end-date: end-date,
          total-cost: total-cost,
          deposit: deposit,
          status: "pending",
          escrow-id: escrow-id,
          timestamp: block-height,
          cancellation-fee: (/ (* total-cost (var-get cancellation-fee-rate)) u100),
          review-rating: none,
          review-comment: none
        }
      )
      (map-set bookings-by-property { property-id: property-id }
        (unwrap-panic (as-max-len? (append (default-to (list) (map-get? bookings-by-property { property-id: property-id })) booking-id) u100))
      )
      (var-set next-booking-id (+ booking-id u1))
      (print { event: "booking-created", id: booking-id })
      (ok booking-id)
    )
  )
)

(define-public (confirm-booking (booking-id uint))
  (let ((booking (unwrap! (get-booking booking-id) (err ERR-BOOKING-NOT-FOUND))))
    (asserts! (is-eq tx-sender (get host booking)) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-eq (get status booking) "pending") (err ERR-INVALID-STATUS))
    (try! (contract-call? .Escrow confirm-escrow (get escrow-id booking)))
    (map-set bookings { booking-id: booking-id }
      (merge booking { status: "confirmed", timestamp: block-height })
    )
    (map-set booking-updates { booking-id: booking-id }
      { update-status: "confirmed", update-timestamp: block-height, updater: tx-sender }
    )
    (print { event: "booking-confirmed", id: booking-id })
    (ok true)
  )
)

(define-public (cancel-booking (booking-id uint))
  (let ((booking (unwrap! (get-booking booking-id) (err ERR-BOOKING-NOT-FOUND))))
    (asserts! (or (is-eq tx-sender (get guest booking)) (is-eq tx-sender (get host booking))) (err ERR-NOT-AUTHORIZED))
    (asserts! (or (is-eq (get status booking) "pending") (is-eq (get status booking) "confirmed")) (err ERR-INVALID-STATUS))
    (let ((fee (if (< block-height (get start-date booking)) (get cancellation-fee booking) (/ (get total-cost booking) u2))))
      (try! (contract-call? .Escrow cancel-escrow (get escrow-id booking) fee))
      (map-set bookings { booking-id: booking-id }
        (merge booking { status: "cancelled", timestamp: block-height })
      )
      (map-set booking-updates { booking-id: booking-id }
        { update-status: "cancelled", update-timestamp: block-height, updater: tx-sender }
      )
      (print { event: "booking-cancelled", id: booking-id })
      (ok true)
    )
  )
)

(define-public (complete-booking (booking-id uint))
  (let ((booking (unwrap! (get-booking booking-id) (err ERR-BOOKING-NOT-FOUND))))
    (asserts! (is-eq tx-sender (get guest booking)) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-eq (get status booking) "confirmed") (err ERR-INVALID-STATUS))
    (asserts! (>= block-height (get end-date booking)) (err ERR-INVALID-DATES))
    (let ((platform-fee (/ (* (get total-cost booking) (var-get platform-fee-rate)) u100)))
      (try! (contract-call? .Escrow release-escrow (get escrow-id booking) platform-fee))
      (map-set bookings { booking-id: booking-id }
        (merge booking { status: "completed", timestamp: block-height })
      )
      (map-set booking-updates { booking-id: booking-id }
        { update-status: "completed", update-timestamp: block-height, updater: tx-sender }
      )
      (print { event: "booking-completed", id: booking-id })
      (ok true)
    )
  )
)

(define-public (add-review (booking-id uint) (rating uint) (comment (string-utf8 500)))
  (let ((booking (unwrap! (get-booking booking-id) (err ERR-BOOKING-NOT-FOUND))))
    (asserts! (is-eq tx-sender (get guest booking)) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-eq (get status booking) "completed") (err ERR-INVALID-STATUS))
    (try! (validate-review-rating rating))
    (try! (validate-review-comment comment))
    (map-set bookings { booking-id: booking-id }
      (merge booking { review-rating: (some rating), review-comment: (some comment) })
    )
    (try! (contract-call? .ReviewSystem add-review booking-id rating comment))
    (print { event: "review-added", id: booking-id })
    (ok true)
  )
)

(define-public (get-booking-count)
  (ok (var-get next-booking-id))
)