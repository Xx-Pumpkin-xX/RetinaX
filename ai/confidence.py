"""
How sure is the model about this grade?

THERE IS NO SOFTMAX HERE, AND THAT IS GOOD NEWS

This model is a REGRESSION model. It emits one continuous score, and
score_to_grade counts how many Nelder-Mead cut points that score has passed:

    thresholds = [0.565, 1.441, 2.375, 3.042]
    grade      = how many of those the score is above

So there is no probability distribution over grades to read a confidence off.
A classifier would hand us a softmax, and we would be tempted to print it as a
percentage — which would be worse than what we can do instead, because softmax
outputs from deep networks are famously overconfident and mean nothing without
a calibration curve nobody here has measured.

What a regression head gives us is better, and it is checkable:

1. MARGIN — how far the score sits from the nearest cut point. A score of
   1.452 with a threshold at 1.441 is eleven thousandths away from being a
   different grade. That is not a confident grade 2, however the model feels.

2. VIEW AGREEMENT — predict_score already runs three test-time-augmented views
   and averages them, throwing the spread away. Grade each view separately and
   the disagreement is a direct, assumption-free uncertainty estimate: if the
   original, the horizontal flip and the vertical flip of the same photograph
   land on different grades, the model is not sure, and no statistics are
   needed to say so.

WHY THIS REPORTS A BAND AND NEVER A PERCENTAGE

A percentage implies calibration — that cases marked 80% are right about 80%
of the time. We have no reliability curve, no Brier score, nothing that would
make such a number true. Printing one would repeat exactly the mistake the
heatmap made: a quantity that looks like evidence, is not, and gets trusted
because it has a number on it.

"Views graded 1, 2, 2" is something a clinician can check and reason about.
"87% confident" is not.
"""

# How close to a cut point counts as borderline, in score units. The narrowest
# band between two thresholds is 2.375 - 1.441 = 0.934 wide, so 0.15 is about a
# sixth of a band — near enough that ordinary noise could cross it.
BORDERLINE_MARGIN = 0.15


def _grade_of(score, thresholds):
    return int(sum(1 for t in thresholds if score >= t))


def grade_confidence(views, thresholds, grade=None):
    """Describe how firm a grade is, from the TTA view scores.

    `views` is the list of raw scores predict_score averaged over — one entry
    if TTA is off. Returns a dict that is safe to show a clinician, or to store
    and audit later.
    """
    views = [float(v) for v in (views or [])]
    thresholds = [float(t) for t in thresholds]
    if not views:
        return None

    score = sum(views) / len(views)
    if grade is None:
        grade = _grade_of(score, thresholds)

    # Distance to the nearest cut point, and which one it is.
    nearest, margin = None, float("inf")
    for t in thresholds:
        d = abs(score - t)
        if d < margin:
            margin, nearest = d, t

    view_grades = [_grade_of(v, thresholds) for v in views]
    agree = sum(1 for g in view_grades if g == grade) / len(view_grades)
    spread = (max(views) - min(views)) if len(views) > 1 else 0.0

    if agree < 1.0:
        band = "uncertain"
    elif margin < BORDERLINE_MARGIN:
        band = "borderline"
    else:
        band = "clear"

    return {
        "score": round(score, 4),
        "views": [round(v, 4) for v in views],
        "view_grades": view_grades,
        "tta": len(views) > 1,
        "spread": round(spread, 4),
        "margin": round(margin, 4),
        "nearest_threshold": nearest,
        "agreement": round(agree, 3),
        "band": band,
        "explanation": _explain(band, view_grades, margin, nearest, grade),
    }


def _explain(band, view_grades, margin, nearest, grade):
    """One sentence a clinician can act on, stating the actual numbers."""
    if band == "uncertain":
        seen = ", ".join(str(g) for g in view_grades)
        return (f"The same photograph graded {seen} across the model's three views. "
                f"Treat this grade as unsettled and read the image yourself.")
    if band == "borderline":
        return (f"The score sits {margin:.3f} from the cut point at {nearest:.3f} — "
                f"close enough that ordinary noise could move it to a neighbouring "
                f"grade. Worth a second look.")
    return (f"All views agreed on grade {grade}, and the score is {margin:.2f} clear "
            f"of the nearest cut point.")
