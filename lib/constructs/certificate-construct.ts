import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';

export interface CertificateConstructProps {
    domainName: string;
    subjectAlternativeNames?: string[];
    hostedZoneId?: string;
    hostedZoneName?: string;
    validationMethod?: acm.ValidationMethod;
}

export class CertificateConstruct extends Construct {
    public readonly certificate: acm.Certificate;
    public readonly hostedZone?: route53.IHostedZone;

    constructor(scope: Construct, id: string, props: CertificateConstructProps) {
        super(scope, id);

        const {
            domainName,
            subjectAlternativeNames,
            hostedZoneId,
            hostedZoneName,
            validationMethod = acm.ValidationMethod.DNS,
        } = props;

        // Get or create hosted zone if DNS validation is used
        if (validationMethod === acm.ValidationMethod.DNS) {
            if (hostedZoneId) {
                this.hostedZone = route53.HostedZone.fromHostedZoneId(
                    this,
                    'HostedZone',
                    hostedZoneId
                );
            } else if (hostedZoneName) {
                this.hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
                    domainName: hostedZoneName,
                });
            }
        }

        // Create certificate
        this.certificate = new acm.Certificate(this, 'Certificate', {
            domainName,
            subjectAlternativeNames,
            validation: this.hostedZone
                ? acm.CertificateValidation.fromDns(this.hostedZone)
                : acm.CertificateValidation.fromEmail(),
        });

        // Output certificate ARN
        new cdk.CfnOutput(this, 'CertificateArn', {
            value: this.certificate.certificateArn,
            description: 'ACM Certificate ARN',
        });
    }
}