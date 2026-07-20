import { AdminLoginSection, adminLoginErrorMessage } from "./admin/_components/admin-login-section";

type HomePageProps = {
  searchParams?: Promise<{
    error?: string | string[];
  }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const errorCode = Array.isArray(params?.error) ? params.error[0] : params?.error;
  return <AdminLoginSection error={adminLoginErrorMessage(errorCode)} returnTo="/" />;
}
