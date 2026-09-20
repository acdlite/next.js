export default function Layout({ children }: { children: React.ReactNode }) {
  // Static, and never reads params.
  return (
    <>
      <p id="static-layout">Static layout above id</p>
      {children}
    </>
  )
}
