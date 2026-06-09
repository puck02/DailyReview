import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Report, User
from app.reports.pdf import markdown_to_pdf_bytes
from app.security import get_current_user


router = APIRouter(prefix="/api/reports", tags=["reports"])


class ReportListItem(BaseModel):
    id: int
    report_type: str
    period: str
    stats: dict
    created_at: str


class ReportContent(BaseModel):
    id: int
    report_type: str
    period: str
    markdown: str
    stats: dict


def _stats(report: Report) -> dict:
    try:
        return json.loads(report.stats_json or "{}")
    except json.JSONDecodeError:
        return {}


@router.get("", response_model=list[ReportListItem])
def list_reports(
    report_type: str = Query(pattern="^(daily|weekly|monthly)$"),
    month: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ReportListItem]:
    query = select(Report).where(Report.user_id == user.id, Report.report_type == report_type)
    if month:
        query = query.where(Report.period.startswith(month))
    reports = db.scalars(query.order_by(Report.period.desc())).all()
    return [
        ReportListItem(
            id=report.id,
            report_type=report.report_type,
            period=report.period,
            stats=_stats(report),
            created_at=report.created_at.isoformat(),
        )
        for report in reports
    ]


@router.get("/{report_id}", response_model=ReportContent)
def get_report(
    report_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ReportContent:
    report = db.get(Report, report_id)
    if report is None or report.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="报告不存在")
    path = Path(report.markdown_path)
    markdown = path.read_text(encoding="utf-8") if path.exists() else ""
    return ReportContent(
        id=report.id,
        report_type=report.report_type,
        period=report.period,
        markdown=markdown,
        stats=_stats(report),
    )


@router.get("/{report_id}/pdf")
def get_report_pdf(
    report_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    report = db.get(Report, report_id)
    if report is None or report.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="报告不存在")
    path = Path(report.markdown_path)
    markdown = path.read_text(encoding="utf-8") if path.exists() else ""
    filename = f"{report.period}-{report.report_type}.pdf"
    return Response(
        content=markdown_to_pdf_bytes(markdown),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
