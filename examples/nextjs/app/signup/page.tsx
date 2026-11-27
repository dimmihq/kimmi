import { Suspense } from 'react';
import { SignupForm } from './signup-form';

export default function SignupPage() {
  return (
    <section className="panel">
      <h1>Create your account</h1>
      <Suspense>
        <SignupForm />
      </Suspense>
    </section>
  );
}
