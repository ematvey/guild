/// Props sections accept when their sub-pages are URL-addressed
/// (/settings/<section>/<detail>): the open sub-page id (null = list page)
/// and the navigation callback that pushes the new URL.
export interface SectionDetailProps {
  detail?: string | null;
  onDetailChange: (detail: string | null) => void;
}
